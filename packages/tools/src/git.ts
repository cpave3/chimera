import { readFile, realpath } from 'node:fs/promises';
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
  // It would override the --ignore-submodules=dirty the tool adds.
  '--no-ignore-submodules',
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

type RunGit = (words: string[]) => Promise<{ stdout: string; exitCode: number }>;

/**
 * A linked worktree keeps its git directory in the main repository, at
 * `<common dir>/worktrees/<name>`. git links the two both ways: the work
 * tree's `.git` file names that directory, and the directory's `gitdir`
 * file names the `.git` file. Only a link that round-trips is trusted.
 */
async function isLinkedWorktree(
  top: string,
  gitDirectory: string,
  commonDirectory: string,
): Promise<boolean> {
  try {
    const [realGitDirectory, realCommonDirectory] = await Promise.all([
      realpath(gitDirectory),
      realpath(commonDirectory),
    ]);
    if (dirname(realGitDirectory) !== join(realCommonDirectory, 'worktrees')) return false;
    const dotGit = join(top, '.git');
    const pointer = (await readFile(dotGit, 'utf8')).match(/^gitdir: (.+)$/m)?.[1]?.trim();
    if (!pointer || (await realpath(resolve(top, pointer))) !== realGitDirectory) return false;
    const back = (await readFile(join(realGitDirectory, 'gitdir'), 'utf8')).trim();
    return (await realpath(resolve(realGitDirectory, back))) === (await realpath(dotGit));
  } catch {
    return false;
  }
}

/**
 * The repository is the boundary: history and objects are repository-wide
 * anyway, so git may read any path in the work tree. The work tree must
 * hold its git directory, or be a linked worktree of it; a submodule, or a
 * `.git` file whose link does not round-trip, is not read.
 */
async function locateRepository(
  run: RunGit,
  cwd: string,
): Promise<{ top: string } | { refusal: string }> {
  const probe = await run([
    'rev-parse',
    '--is-inside-work-tree',
    '--show-prefix',
    '--path-format=relative',
    '--git-dir',
    '--git-common-dir',
  ]);
  const [inWorkTree, prefix = '', ...directories] = probe.stdout.split('\n');
  if (probe.exitCode !== 0 || inWorkTree !== 'true') {
    return { refusal: `${cwd} is not in a git work tree.` };
  }
  const top = resolve(
    cwd,
    ...prefix
      .split('/')
      .filter(Boolean)
      .map(() => '..'),
  );
  const realTop = await resolveExisting(top);
  const [gitDirectory, commonDirectory] = directories.map((directory) => resolve(cwd, directory));
  if (!gitDirectory || !commonDirectory) return { refusal: `${cwd} is not in a git work tree.` };
  const inside = async (path: string) =>
    within(top, path) && within(realTop, await resolveExisting(path));
  if ((await inside(gitDirectory)) && (await inside(commonDirectory))) return { top };
  if (await isLinkedWorktree(top, gitDirectory, commonDirectory)) return { top };
  return {
    refusal: `the git directory ${gitDirectory} is outside the work tree at ${top}, and it is not a linked worktree whose link round-trips. A submodule is not read.`,
  };
}

/**
 * A pathspec outside the repository would let `log`, `show` or `status`
 * look there, and `diff` given one such path compares the two as plain
 * files even without `--no-index`.
 */
async function pathRefusal(cwd: string, top: string, args: string[]): Promise<string | undefined> {
  const candidates = pathCandidates(args);
  if (candidates.length === 0) return undefined;
  const realTop = await resolveExisting(top);
  for (const arg of candidates) {
    const lexical = resolve(cwd, arg);
    if (
      isAbsolute(arg) ||
      !within(top, lexical) ||
      !within(realTop, await resolveExisting(lexical))
    ) {
      return `${arg} is absolute or outside the repository. Give paths relative to the working directory, and attach an option's value with =.`;
    }
  }
  return undefined;
}

function git(words: string[]): string {
  return ['git', ...GLOBAL_OPTIONS, ...words].map(shellQuote).join(' ');
}

function gitCommand(words: string[]): string {
  return `unset ${REPOSITORY_ENV.join(' ')}; exec ${git(words)}`;
}

/**
 * A clean filter runs whenever git compares a work-tree file that the
 * attributes select, `diff` and `status` included. Filter drivers have
 * names of their own, so each configured one is emptied by name.
 * `converting` are the drivers that had a clean or process command.
 */
async function filterOverrides(
  run: RunGit,
): Promise<{ options: string[]; converting: Set<string> } | { refusal: string }> {
  const listing = await run(['config', '--null', '--name-only', '--get-regexp', '^filter\\.']);
  const drivers = new Set<string>();
  const converting = new Set<string>();
  for (const key of listing.stdout.split('\0')) {
    if (!key.startsWith('filter.')) continue;
    const driver = key.slice('filter.'.length, key.lastIndexOf('.'));
    drivers.add(driver);
    if (key.endsWith('.clean') || key.endsWith('.process')) converting.add(driver);
  }
  const options: string[] = [];
  for (const driver of drivers) {
    // `-c` splits at the first `=`: such a name cannot be overridden.
    if (driver.includes('=')) return { refusal: `filter driver "${driver}" cannot be turned off.` };
    for (const setting of ['clean=', 'process=', 'required=false']) {
      options.push('-c', `filter.${driver}.${setting}`);
    }
  }
  return { options, converting };
}

/**
 * Whether the call compares the work tree: `status` does, and so does
 * `diff` unless it compares the index (`--cached`) or two commits. An
 * option's value can be an argument of its own (`-S HEAD`), and only git's
 * option table says which: so a positional right after an option makes the
 * count of revisions `ambiguous`.
 */
async function workTreeComparison(
  subcommand: string,
  args: string[],
  run: RunGit,
): Promise<'none' | 'work-tree' | 'ambiguous'> {
  if (subcommand === 'status') return 'work-tree';
  if (subcommand !== 'diff') return 'none';
  const separator = args.indexOf('--');
  const options = separator === -1 ? args : args.slice(0, separator);
  if (options.includes('--cached') || options.includes('--staged')) return 'none';
  const positionals = options.filter((arg) => !arg.startsWith('-'));
  if (positionals.length === 0) return 'work-tree';
  const followsOption = options.some(
    (arg, i) => i > 0 && !arg.startsWith('-') && /^-[^=]*$/.test(options[i - 1]!),
  );
  if (followsOption) return 'ambiguous';
  const revisions = await run(['rev-parse', '--revs-only', ...positionals]);
  return revisions.stdout.split('\n').filter(Boolean).length < 2 ? 'work-tree' : 'none';
}

/** The first converting filter driver that a tracked file's attributes select, anywhere in the repository. */
async function trackedFilter(
  exec: (command: string) => Promise<{ stdout: string }>,
  converting: Set<string>,
): Promise<string | undefined> {
  if (converting.size === 0) return undefined;
  const listing = await exec(
    `unset ${REPOSITORY_ENV.join(' ')}; ${git(['ls-files', '-z', '--', ':/'])} | ${git(['check-attr', '--stdin', '-z', 'filter'])}`,
  );
  // -z output: path, attribute, value, each ended by a NUL.
  const fields = listing.stdout.split('\0');
  for (let i = 2; i < fields.length; i += 3) {
    if (converting.has(fields[i]!)) return fields[i];
  }
  return undefined;
}

function refuse(reason: string): GitResult {
  return { stdout: '', stderr: `refused by chimera: ${reason}`, exit_code: -1, timed_out: false };
}

export function buildGitTool(ctx: ToolContext) {
  return defineTool<GitArgs, GitResult>({
    description:
      'Run a read-only git command on the repository of the working directory: log, show, diff, ' +
      'rev-parse, merge-base, status, branch (list mode) or cat-file. Never asks for approval. ' +
      'Options that write files, run external programs or leave the repository are refused.',
    promptSnippet:
      'Read git history and state: log, show, diff, status, rev-parse, merge-base, branch --contains, cat-file.',
    inputSchema: GIT_SCHEMA,
    execute: async (args, { abortSignal } = {}) => {
      // The schema's enum does not hold when execute is called directly.
      if (!(READ_SUBCOMMANDS as readonly string[]).includes(args.subcommand)) {
        return refuse(`git ${args.subcommand} is not a read-only git command.`);
      }
      const refusal = argumentRefusal(args.subcommand, args.args ?? []);
      if (refusal) return refuse(refusal);
      const timeoutMs = args.timeout_ms ?? 30_000;
      const exec = (command: string) =>
        ctx.sandboxExecutor.exec(command, {
          signal: abortSignal,
          timeoutMs,
          env: ENV,
          toolName: 'git',
        });
      const run = (words: string[]) => exec(gitCommand(words));
      const cwd = ctx.sandboxExecutor.cwd();
      const repository = await locateRepository(run, cwd);
      if ('refusal' in repository) return refuse(repository.refusal);
      const pathRefused = await pathRefusal(cwd, repository.top, args.args ?? []);
      if (pathRefused) return refuse(pathRefused);
      const filters = await filterOverrides(run);
      if ('refusal' in filters) return refuse(filters.refusal);
      // Without its clean filter, git sees a converted file as changed.
      const comparison = await workTreeComparison(args.subcommand, args.args ?? [], run);
      const driver =
        comparison === 'none' ? undefined : await trackedFilter(exec, filters.converting);
      if (driver) {
        const filtered = `tracked files use the clean filter "${driver}", which the git tool does not run`;
        return refuse(
          comparison === 'ambiguous'
            ? `${filtered}, and a revision here follows an option that may take it as its value. Put the revisions first and give long options their value with =: diff A B --stat.`
            : `${filtered}, so git ${args.subcommand} would report the work tree wrongly. Compare commits (diff A B), the index (diff --cached), or use log and show.`,
        );
      }
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
