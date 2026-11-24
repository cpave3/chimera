import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { clip } from './format';
import { shellQuote } from './os-sandbox';

const READ_SUBCOMMANDS = [
  'log',
  'show',
  'diff',
  'rev-parse',
  'merge-base',
  'status',
  'branch',
  'cat-file',
] as const;

const GIT_SCHEMA = z.object({
  subcommand: z.enum(READ_SUBCOMMANDS).describe('The git subcommand. Only these reads exist.'),
  args: z
    .array(z.string())
    .optional()
    .describe(
      'Arguments after the subcommand, one per item, unquoted: ["--oneline", "main..HEAD"].',
    ),
  timeout_ms: z.number().int().positive().optional().describe('Timeout in ms. Default 30000.'),
});
type GitArgs = z.infer<typeof GIT_SCHEMA>;
type GitResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  /** Present when stdout was cut at MAX_OUTPUT_CHARS or by the executor's own cap. */
  truncated?: true;
};

/**
 * A ceiling, not the context budget: the session's output budget trims a
 * result to fit the context and archives the rest for `recall`. This keeps
 * a `git log -p` of a whole history from reaching it at all.
 */
const MAX_OUTPUT_CHARS = 256_000;

/** A program path that cannot run: git fails to start it and carries on. */
const NO_PROGRAM = '/dev/null/none';

/**
 * Before the subcommand: no pager, no optional index refresh (`status`
 * would rewrite `.git/index`), and none of the programs git starts on its
 * own from config: fsmonitor, hooks, signature verification (`%G?`,
 * `--show-signature`, `log.showSignature`) and the submodule summary.
 */
const GLOBAL_OPTIONS = [
  '--no-pager',
  '--no-optional-locks',
  ...[
    'core.fsmonitor=false',
    'core.hooksPath=/dev/null',
    `gpg.program=${NO_PROGRAM}`,
    `gpg.openpgp.program=${NO_PROGRAM}`,
    `gpg.ssh.program=${NO_PROGRAM}`,
    `gpg.x509.program=${NO_PROGRAM}`,
    'log.showSignature=false',
    'diff.submodule=short',
    'status.submoduleSummary=false',
  ].flatMap((setting) => ['-c', setting]),
];
/** Subcommands that would run a configured external diff or textconv program. */
const DIFF_SUBCOMMANDS = new Set(['log', 'show', 'diff']);
/**
 * Subcommands that compare the work tree. In a submodule that changed, git
 * runs a child git with the submodule's own config, filters included.
 */
const WORK_TREE_SUBCOMMANDS = new Set(['diff', 'status']);
const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
/** Inherited variables that would point git at another repository than the working directory's. */
const REPOSITORY_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
];

/**
 * Options that write a file, run a configured program, read outside the
 * repository or point git at another repository. git accepts a unique
 * prefix of a long option, so an abbreviation is refused too.
 */
const REFUSED_LONG_OPTIONS = [
  '--output',
  '--ext-diff',
  '--textconv',
  '--filters',
  '--no-index',
  '--exec',
  '--exec-path',
  '--upload-pack',
  '--git-dir',
  '--work-tree',
];

/** Options that are prefixes of a refused option but that git takes as written. */
const EXACT_OPTIONS = new Set(['--text', '--filter']);

/** Values that would make git run a child git in a submodule, with the submodule's config. */
const REFUSED_VALUES: Record<string, string[]> = {
  '--submodule': ['diff'],
  '--ignore-submodules': ['none', 'untracked'],
};

function abbreviates(name: string, option: string): boolean {
  return name.startsWith(option) || (name.length > 2 && option.startsWith(name));
}

function refusedOption(arg: string): string | undefined {
  if (/^-[cC]/.test(arg)) return arg.slice(0, 2);
  if (!arg.startsWith('--')) return undefined;
  const [name, value] = arg.split(/=(.*)/s) as [string, string | undefined];
  if (EXACT_OPTIONS.has(name)) return undefined;
  for (const [option, values] of Object.entries(REFUSED_VALUES)) {
    if (value !== undefined && values.includes(value) && abbreviates(name, option)) return arg;
  }
  return REFUSED_LONG_OPTIONS.find((refused) => abbreviates(name, refused));
}

/** `git branch` options that make it list branches. Without one it creates a branch. */
const BRANCH_LIST_OPTIONS = new Set([
  '--list',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--all',
  '--remotes',
  '--show-current',
]);
const BRANCH_DISPLAY_OPTIONS = new Set([
  '--verbose',
  '--format',
  '--sort',
  '--column',
  '--no-column',
  '--color',
  '--no-color',
  '--abbrev',
  '--no-abbrev',
  '--ignore-case',
  '--omit-empty',
]);
const BRANCH_LIST_FLAGS = 'arl';
const BRANCH_DISPLAY_FLAGS = 'vi';

/**
 * `git branch` lists only in list mode, and every other option it takes
 * writes a ref or config: so it gets an allowlist, and a list option is
 * required.
 */
function branchRefusal(args: string[]): string | undefined {
  let listing = false;
  for (const arg of args) {
    if (!arg.startsWith('-')) continue;
    if (arg === '--') return 'git branch takes no paths; drop the --.';
    if (arg.startsWith('--')) {
      const name = arg.split('=', 1)[0]!;
      if (BRANCH_LIST_OPTIONS.has(name)) listing = true;
      else if (!BRANCH_DISPLAY_OPTIONS.has(name)) return `git branch ${name} is not a listing.`;
      continue;
    }
    for (const flag of arg.slice(1)) {
      if (BRANCH_LIST_FLAGS.includes(flag)) listing = true;
      else if (!BRANCH_DISPLAY_FLAGS.includes(flag)) return `git branch -${flag} is not a listing.`;
    }
  }
  if (!listing) {
    return 'git branch lists branches only with --list, --contains, --merged, --points-at, -a or -r.';
  }
  return undefined;
}

/** Why `args` are refused, or nothing. Arguments after a literal `--` are paths. */
function argumentRefusal(subcommand: string, args: string[]): string | undefined {
  for (const arg of args) {
    if (arg === '--') break;
    const refused = refusedOption(arg);
    if (refused) return `the git tool does not accept ${refused}.`;
  }
  return subcommand === 'branch' ? branchRefusal(args) : undefined;
}

/**
 * The positional arguments and everything after `--`: revisions and paths.
 * git cannot always tell them apart either, so every one is checked as a path.
 */
function pathCandidates(args: string[]): string[] {
  const separator = args.indexOf('--');
  const before = separator === -1 ? args : args.slice(0, separator);
  const after = separator === -1 ? [] : args.slice(separator + 1);
  return [...before.filter((arg) => !arg.startsWith('-')), ...after];
}

/** `path` with its existing part resolved through symlinks. */
async function resolveExisting(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await resolveExisting(parent), basename(path));
  }
}

function within(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The read tool keeps to the working directory, and so does this one: a
 * pathspec outside it would let `log`, `show` or `status` look there, and
 * `diff` given one such path compares the two as plain files even without
 * `--no-index`.
 */
async function pathRefusal(cwd: string, args: string[]): Promise<string | undefined> {
  const candidates = pathCandidates(args);
  if (candidates.length === 0) return undefined;
  const realCwd = await resolveExisting(cwd);
  for (const arg of candidates) {
    const lexical = resolve(cwd, arg);
    if (
      isAbsolute(arg) ||
      !within(cwd, lexical) ||
      !within(realCwd, await resolveExisting(lexical))
    ) {
      return `${arg} is outside the working directory. If it is the value of an option, attach it with =.`;
    }
  }
  return undefined;
}

function gitCommand(words: string[]): string {
  const git = ['git', ...GLOBAL_OPTIONS, ...words].map(shellQuote).join(' ');
  return `unset ${REPOSITORY_ENV.join(' ')}; exec ${git}`;
}

/**
 * A clean filter runs whenever git compares a work-tree file that the
 * attributes select, `diff` and `status` included. Filter drivers have
 * names of their own, so each configured one is emptied by name.
 */
async function filterOverrides(
  run: (words: string[]) => Promise<{ stdout: string; exitCode: number }>,
): Promise<{ options: string[] } | { refusal: string }> {
  const listing = await run(['config', '--null', '--name-only', '--get-regexp', '^filter\\.']);
  const drivers = new Set<string>();
  for (const key of listing.stdout.split('\0')) {
    if (!key.startsWith('filter.')) continue;
    drivers.add(key.slice('filter.'.length, key.lastIndexOf('.')));
  }
  const options: string[] = [];
  for (const driver of drivers) {
    // `-c` splits at the first `=`: such a name cannot be overridden.
    if (driver.includes('=')) return { refusal: `filter driver "${driver}" cannot be turned off.` };
    for (const setting of ['clean=', 'process=', 'required=false']) {
      options.push('-c', `filter.${driver}.${setting}`);
    }
  }
  return { options };
}

function refuse(reason: string): GitResult {
  return { stdout: '', stderr: `refused by chimera: ${reason}`, exit_code: -1, timed_out: false };
}

export function buildGitTool(ctx: ToolContext) {
  return defineTool<GitArgs, GitResult>({
    description:
      'Run a read-only git command in the working directory: log, show, diff, rev-parse, ' +
      'merge-base, status, branch (list mode) or cat-file. Never asks for approval. ' +
      'Options that write files, run external programs or leave the working directory are refused.',
    promptSnippet:
      'Read git history and state: log, show, diff, status, rev-parse, merge-base, branch --contains, cat-file.',
    inputSchema: GIT_SCHEMA,
    execute: async (args, { abortSignal } = {}) => {
      // The schema's enum does not hold when execute is called directly.
      if (!(READ_SUBCOMMANDS as readonly string[]).includes(args.subcommand)) {
        return refuse(`git ${args.subcommand} is not a read-only git command.`);
      }
      const refusal =
        argumentRefusal(args.subcommand, args.args ?? []) ??
        (await pathRefusal(ctx.sandboxExecutor.cwd(), args.args ?? []));
      if (refusal) return refuse(refusal);
      const timeoutMs = args.timeout_ms ?? 30_000;
      const run = (words: string[]) =>
        ctx.sandboxExecutor.exec(gitCommand(words), {
          signal: abortSignal,
          timeoutMs,
          env: ENV,
          toolName: 'git',
        });
      const filters = await filterOverrides(run);
      if ('refusal' in filters) return refuse(filters.refusal);
      const result = await run([
        ...filters.options,
        args.subcommand,
        ...(DIFF_SUBCOMMANDS.has(args.subcommand) ? ['--no-ext-diff', '--no-textconv'] : []),
        ...(WORK_TREE_SUBCOMMANDS.has(args.subcommand) ? ['--ignore-submodules=dirty'] : []),
        ...(args.args ?? []),
      ]);
      const cut = result.stdout.length > MAX_OUTPUT_CHARS;
      const stdout = cut
        ? `${result.stdout.slice(0, MAX_OUTPUT_CHARS)}\n[git: output cut at ${MAX_OUTPUT_CHARS} characters. Narrow it: a revision range, -n <count>, --stat, or a path after --.]`
        : result.stdout;
      return {
        stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        ...(cut || result.stdoutTruncated ? { truncated: true as const } : {}),
      };
    },
    formatScrollback: (args, result) => {
      const head = clip(['git', args.subcommand, ...(args.args ?? [])].join(' '), 60);
      if (!result) return { summary: head };
      if (result.timed_out) return { summary: `${head} (timed out)` };
      return { summary: `${head} (exit ${result.exit_code})` };
    },
  });
}
