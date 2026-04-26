import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { deleteSession, listSessionsOnDisk, sessionDir, type SessionInfo } from '@chimera/core';

export interface RunSessionsListOpts {
  /** Default cwd for filtering. Required unless `all` is true. */
  cwd?: string;
  /** Show every session, not just those whose cwd matches `cwd`. */
  all?: boolean;
  home?: string;
}

function filterByCwd(sessions: SessionInfo[], cwd: string): SessionInfo[] {
  const target = resolve(cwd);
  return sessions.filter((s) => resolve(s.cwd) === target);
}

export async function runSessionsList(opts: RunSessionsListOpts = {}): Promise<void> {
  const home = opts.home ?? homedir();
  const all = await listSessionsOnDisk(home);
  const filtered = opts.all || !opts.cwd ? all : filterByCwd(all, opts.cwd);
  filtered.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  if (filtered.length === 0) {
    if (!opts.all && opts.cwd) {
      process.stdout.write(
        `No sessions in ${resolve(opts.cwd)}. (Use --all to list every persisted session.)\n`,
      );
    } else {
      process.stdout.write('No sessions.\n');
    }
    return;
  }
  process.stdout.write('ID\tCWD\tMESSAGES\tLAST ACTIVITY\tPARENT\n');
  for (const s of filtered) {
    const last = new Date(s.lastActivityAt).toISOString();
    process.stdout.write(`${s.id}\t${s.cwd}\t${s.messageCount}\t${last}\t${s.parentId ?? '-'}\n`);
  }
}

export async function runSessionsRm(sessionId: string, home = homedir()): Promise<void> {
  const dir = sessionDir(sessionId, home);
  if (!existsSync(dir)) {
    process.stderr.write(`No such session: ${sessionId}\n`);
    process.exit(1);
  }
  const sessions = await listSessionsOnDisk(home);
  const target = sessions.find((s) => s.id === sessionId);
  if (target && target.children.length > 0) {
    process.stderr.write(
      `Cannot delete ${sessionId}: has ${target.children.length} child session(s). Delete children first.\n`,
    );
    process.exit(1);
  }
  await deleteSession(sessionId, home);
  process.stdout.write(`Deleted ${sessionId}\n`);
}

/**
 * Find the most-recently-active session in `cwd`. Returns `null` if no
 * sessions match.
 */
export async function findLatestSessionInCwd(
  cwd: string,
  home = homedir(),
): Promise<SessionInfo | null> {
  const all = await listSessionsOnDisk(home);
  const matching = filterByCwd(all, cwd);
  if (matching.length === 0) return null;
  matching.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return matching[0]!;
}

export interface ResolveSessionIdOptions {
  home?: string;
  /**
   * When set, suffix matches are scoped to sessions whose `cwd` resolves
   * to this path — preventing `chimera sessions rm <8-char>` from project
   * A from accidentally matching a session in project B.
   *
   * A full-ULID exact match still resolves regardless of cwd, since the
   * full id is unambiguous.
   */
  cwd?: string;
}

export async function resolveSessionId(
  idOrSuffix: string,
  options: ResolveSessionIdOptions = {},
): Promise<string> {
  const allSessions = await listSessionsOnDisk(options.home);
  const exactMatch = allSessions.find((session) => session.id === idOrSuffix);
  if (exactMatch) return exactMatch.id;

  const upperNeedle = idOrSuffix.toUpperCase();
  const candidates = options.cwd ? filterByCwd(allSessions, options.cwd) : allSessions;
  const suffixMatches = candidates.filter((session) =>
    session.id.toUpperCase().endsWith(upperNeedle),
  );

  if (suffixMatches.length === 1) return suffixMatches[0]!.id;
  if (suffixMatches.length > 1) {
    const matches = suffixMatches.map((session) => `  ${session.id}  ${session.cwd}`).join('\n');
    throw new Error(
      `Ambiguous session id "${idOrSuffix}" — matches ${suffixMatches.length} sessions:\n${matches}`,
    );
  }
  // No suffix match in the requested scope — but if the user passed a
  // suffix that uniquely identifies a session in *another* directory,
  // fail with a helpful hint rather than blindly matching it.
  if (options.cwd) {
    const globalSuffixMatches = allSessions.filter((session) =>
      session.id.toUpperCase().endsWith(upperNeedle),
    );
    if (globalSuffixMatches.length > 0) {
      throw new Error(
        `No session matching "${idOrSuffix}" in ${resolve(options.cwd)} — matched ${globalSuffixMatches.length} session(s) in other directories. Pass the full ULID to resolve unambiguously.`,
      );
    }
  }
  throw new Error(`No session matching "${idOrSuffix}"`);
}

/**
 * Interactive numbered-picker on stdin. Lists sessions for the given `cwd`
 * (newest activity first) and asks the user to pick by number. Returns the
 * chosen session id, or `null` if the user cancels (Ctrl+D / empty input)
 * or no sessions match.
 *
 * Used by `chimera --resume` (no value) before the TUI mounts.
 */
export async function pickSessionInteractive(
  cwd: string,
  home = homedir(),
): Promise<string | null> {
  const all = await listSessionsOnDisk(home);
  const matching = filterByCwd(all, cwd);
  if (matching.length === 0) {
    process.stderr.write(`No sessions in ${resolve(cwd)}.\n`);
    return null;
  }
  matching.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  process.stdout.write(`Sessions in ${resolve(cwd)}:\n`);
  matching.forEach((s, i) => {
    const last = formatRelative(Date.now(), s.lastActivityAt);
    const fork = s.parentId ? ' (forked)' : '';
    process.stdout.write(
      `  [${i + 1}] ${s.id.slice(-8)}  ${last.padEnd(10)}  ${s.messageCount} msg${fork}\n`,
    );
  });
  process.stdout.write('Pick a session [1]: ');
  const answer = await readLine();
  if (answer === null) return null;
  const trimmed = answer.trim();
  const idx = trimmed === '' ? 1 : Number.parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > matching.length) {
    process.stderr.write(`Invalid selection: ${trimmed}\n`);
    return null;
  }
  return matching[idx - 1]!.id;
}

function formatRelative(now: number, then: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function readLine(): Promise<string | null> {
  return new Promise((resolveLine) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      const nl = s.indexOf('\n');
      if (nl >= 0) {
        buf += s.slice(0, nl);
        process.stdin.removeListener('data', onData);
        process.stdin.removeListener('end', onEnd);
        process.stdin.pause();
        resolveLine(buf);
      } else {
        buf += s;
      }
    };
    const onEnd = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      resolveLine(buf.length > 0 ? buf : null);
    };
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    if (process.stdin.isPaused()) process.stdin.resume();
  });
}
