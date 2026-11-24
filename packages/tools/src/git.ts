import { isAbsolute, posix } from 'node:path';
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

/**
 * Before the subcommand: no pager, no optional index refresh (`status`
 * would rewrite `.git/index`), and no fsmonitor or hook program from the
 * repository's config.
 */
const GLOBAL_OPTIONS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];
/** Subcommands that would run a configured external diff or textconv program. */
const DIFF_SUBCOMMANDS = new Set(['log', 'show', 'diff']);
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

function refusedOption(arg: string): string | undefined {
  if (/^-[cC]/.test(arg)) return arg.slice(0, 2);
  if (!arg.startsWith('--')) return undefined;
  const name = arg.split('=', 1)[0]!;
  if (EXACT_OPTIONS.has(name)) return undefined;
  return REFUSED_LONG_OPTIONS.find(
    (refused) => name.startsWith(refused) || (name.length > 2 && refused.startsWith(name)),
  );
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
  if (subcommand === 'branch') return branchRefusal(args);
  if (subcommand === 'diff') return diffPathRefusal(args);
  return undefined;
}

/**
 * Given two paths and one outside the working tree, `git diff` compares
 * them as plain files, with or without `--no-index`: so it reads any file.
 * The read tool keeps to the working directory, and so does this one.
 */
function diffPathRefusal(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const normalized = posix.normalize(arg);
    if (isAbsolute(arg) || normalized === '..' || normalized.startsWith('../')) {
      return `git diff does not read ${arg}: it is outside the working directory.`;
    }
  }
  return undefined;
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
      const refusal = argumentRefusal(args.subcommand, args.args ?? []);
      if (refusal) return refuse(refusal);
      const words = [
        'git',
        ...GLOBAL_OPTIONS,
        args.subcommand,
        ...(DIFF_SUBCOMMANDS.has(args.subcommand) ? ['--no-ext-diff', '--no-textconv'] : []),
        ...(args.args ?? []),
      ];
      const command = `unset ${REPOSITORY_ENV.join(' ')}; exec ${words.map(shellQuote).join(' ')}`;
      const result = await ctx.sandboxExecutor.exec(command, {
        signal: abortSignal,
        timeoutMs: args.timeout_ms ?? 30_000,
        env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        toolName: 'git',
      });
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
