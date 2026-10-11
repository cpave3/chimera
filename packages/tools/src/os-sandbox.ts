import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** What a sandboxed host command may do. Reads are allowed everywhere. */
export interface OsSandboxSpec {
  /** The session's working directory: writable, and where the command starts. */
  cwd: string;
  /** The temp directory: writable. */
  tmp: string;
  /** More writable directories: granted write paths and configured ones. */
  writablePaths: string[];
  /** Read-only even inside a writable directory: the agent's own rules and hooks. */
  readOnlyPaths: string[];
  network: 'on' | 'off';
}

export type OsSandboxKind = 'bwrap' | 'sandbox-exec';

/** Runs host commands inside the operating system's sandbox. */
export interface OsSandbox {
  kind: OsSandboxKind;
  spec: OsSandboxSpec;
  /** A shell command that runs `command` in the sandbox, for `sh -c`. */
  wrap(command: string): string;
}

/** Quote one word for `sh`. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The bubblewrap command for `command`. The whole filesystem is bound
 * read-only first; later binds win, so the writable directories come next
 * and the protected ones last. A path that does not exist is left out:
 * bubblewrap would refuse to start.
 */
export function bwrapCommand(spec: OsSandboxSpec, command: string): string {
  const args = ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
  for (const path of [spec.tmp, spec.cwd, ...spec.writablePaths]) {
    if (existsSync(path)) args.push('--bind', path, path);
  }
  for (const path of spec.readOnlyPaths) {
    if (existsSync(path)) args.push('--ro-bind', path, path);
  }
  if (spec.network === 'off') args.push('--unshare-net');
  args.push('--chdir', spec.cwd, '--', 'sh', '-c', command);
  return ['bwrap', ...args].map(shellQuote).join(' ');
}

/** Where a `.git` file points: the git directory of a linked worktree or a submodule. */
function gitDirectoryOf(gitFile: string, worktree: string): string | null {
  const pointer = readFileSync(gitFile, 'utf8')
    .match(/^gitdir: (.+)$/m)?.[1]
    ?.trim();
  if (!pointer) return null;
  const gitDirectory = isAbsolute(pointer) ? pointer : resolve(worktree, pointer);
  try {
    // A linked worktree keeps its objects and refs in the main working tree's git directory.
    return resolve(gitDirectory, readFileSync(join(gitDirectory, 'commondir'), 'utf8').trim());
  } catch {
    return gitDirectory;
  }
}

/**
 * The git directory `git` must write for work in `cwd`, when it is not
 * below `cwd` already: `cwd` is a linked worktree, a submodule, or a
 * directory below the root of its repository. Without it a sandboxed
 * `git commit` fails.
 */
export function gitWritePaths(cwd: string): string[] {
  const start = resolve(cwd);
  for (let directory = start; ; directory = dirname(directory)) {
    const git = join(directory, '.git');
    try {
      const entry = statSync(git);
      if (entry.isFile()) {
        const gitDirectory = gitDirectoryOf(git, directory);
        return gitDirectory ? [gitDirectory] : [];
      }
      if (entry.isDirectory()) return directory === start ? [] : [git];
    } catch {
      // no .git here
    }
    if (dirname(directory) === directory) return [];
  }
}

function seatbeltString(path: string): string {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * The Seatbelt profile for macOS `sandbox-exec`: everything is allowed, then
 * writes are denied except in the writable directories, then denied again
 * in the protected ones. The last rule that matches wins.
 */
export function seatbeltProfile(spec: OsSandboxSpec): string {
  const writable = [spec.cwd, spec.tmp, ...spec.writablePaths];
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((path) => `(subpath ${seatbeltString(path)})`).join(' ')}`,
    // Programs write to these as a matter of course; none of them is a file.
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty")',
    // The per-user temp and cache directories macOS hands to every process.
    '  (subpath "/private/var/folders"))',
    ...spec.readOnlyPaths.map((path) => `(deny file-write* (subpath ${seatbeltString(path)}))`),
    ...(spec.network === 'off' ? ['(deny network*)'] : []),
  ];
  return lines.join('\n');
}

export function seatbeltCommand(spec: OsSandboxSpec, command: string): string {
  return ['sandbox-exec', '-p', seatbeltProfile(spec), 'sh', '-c', command]
    .map(shellQuote)
    .join(' ');
}

function probeBwrap(): boolean {
  // The program can be installed and still not work: user namespaces can be turned off.
  const result = spawnSync(
    'bwrap',
    ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'],
    { stdio: 'ignore', timeout: 5_000 },
  );
  return result.status === 0;
}

/** The OS sandbox this machine can run, or null. */
export function detectOsSandbox(
  options: { platform?: NodeJS.Platform; probe?: (kind: OsSandboxKind) => boolean } = {},
): OsSandboxKind | null {
  const platform = options.platform ?? process.platform;
  const probe =
    options.probe ??
    ((kind: OsSandboxKind) =>
      kind === 'bwrap' ? probeBwrap() : existsSync('/usr/bin/sandbox-exec'));
  if (platform === 'linux') return probe('bwrap') ? 'bwrap' : null;
  if (platform === 'darwin') return probe('sandbox-exec') ? 'sandbox-exec' : null;
  return null;
}

export function createOsSandbox(kind: OsSandboxKind, spec: OsSandboxSpec): OsSandbox {
  return {
    kind,
    spec,
    wrap: (command) =>
      kind === 'bwrap' ? bwrapCommand(spec, command) : seatbeltCommand(spec, command),
  };
}

// What the kernel says when the sandbox refuses a write.
const WRITE_REFUSED = /Read-only file system|EROFS|Operation not permitted/;
// What tools say when there is no network to reach.
const NETWORK_REFUSED =
  /Could not resolve host|Temporary failure in name resolution|Network is unreachable|ENETUNREACH|EAI_AGAIN|getaddrinfo/;

/**
 * A note for the model when a sandboxed command failed because of the
 * sandbox, or null. The match is on the wording of the failure, so it can
 * miss; then the model only goes without the hint.
 */
export function sandboxBlockNote(
  result: { exitCode: number; stderr: string },
  spec: OsSandboxSpec,
): string | null {
  if (result.exitCode === 0) return null;
  const how =
    'If the command must do this, call bash again with unsandboxed: true and a reason; the user is then asked to approve it.';
  if (spec.network === 'off' && NETWORK_REFUSED.test(result.stderr)) {
    return `The OS sandbox has no network access (commandPolicy.hostBash.network is "off"). ${how}`;
  }
  if (WRITE_REFUSED.test(result.stderr)) {
    const writable = [spec.cwd, spec.tmp, ...spec.writablePaths].join(', ');
    return `The OS sandbox refused a write. Commands may write only in: ${writable}. The .chimera directories are read-only. ${how}`;
  }
  return null;
}
