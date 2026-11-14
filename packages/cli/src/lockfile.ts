import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionId } from '@chimera/core';

export interface Lockfile {
  pid: number;
  port: number;
  cwd: string;
  sessionId?: SessionId;
  startedAt: number;
  version: string;
  url: string;
}

export function instancesDir(home = homedir()): string {
  return join(home, '.chimera', 'instances');
}

export function lockfilePath(pid: number, home = homedir()): string {
  return join(instancesDir(home), `${pid}.json`);
}

export function writeLockfile(lock: Lockfile, home = homedir()): string {
  const dir = instancesDir(home);
  mkdirSync(dir, { recursive: true });
  const path = lockfilePath(lock.pid, home);
  writeFileSync(path, JSON.stringify(lock, null, 2), 'utf8');
  return path;
}

export function removeLockfile(pid: number, home = homedir()): void {
  try {
    unlinkSync(lockfilePath(pid, home));
  } catch {
    // already gone
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM means process exists but we can't signal it → still alive.
    return code === 'EPERM';
  }
}

/** Scan instances dir, delete stale lockfiles, return live instances. */
export function listLiveInstances(home = homedir()): Lockfile[] {
  const dir = instancesDir(home);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const alive: Lockfile[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    try {
      const lock = JSON.parse(readFileSync(path, 'utf8')) as Lockfile;
      if (isPidAlive(lock.pid)) {
        alive.push(lock);
      } else {
        unlinkSync(path);
      }
    } catch {
      // corrupt — delete
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    }
  }
  return alive;
}

/** A lockfile whose instance was asked and found to be there. */
export interface VerifiedInstance extends Lockfile {
  /** False when the instance did not answer in time; it may only be busy. */
  responsive: boolean;
}

export interface VerifyInstancesOptions {
  home?: string;
  fetch?: typeof fetch;
  /** How long an instance has to answer. */
  timeoutMs?: number;
}

const VERIFY_TIMEOUT_MS = 1_000;

/** Whether a failed request means that nothing listens on the port at all. */
function connectionRefused(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);
    const { code, cause, errors } = current as {
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (code === 'ECONNREFUSED') return true;
    pending.push(cause);
    // A host with several addresses fails with one error for each.
    if (Array.isArray(errors)) pending.push(...errors);
  }
  return false;
}

/**
 * The instances that are really there. A live PID proves little: after a
 * crash the kernel gives the number to another process, or to a thread, and
 * the lockfile outlives the instance. So each lockfile's server is asked who
 * it is. A port that refuses the connection, or that answers as something
 * else, means the instance is gone, and its lockfile is removed. A 404 may
 * hide a secret-protected instance, so it is kept, like one that times out.
 */
export async function listVerifiedInstances(
  options: VerifyInstancesOptions = {},
): Promise<VerifiedInstance[]> {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const checked = await Promise.all(
    listLiveInstances(options.home).map(async (lock): Promise<VerifiedInstance | null> => {
      try {
        const response = await request(`${lock.url}/v1/instance`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        // A protected instance deliberately hides this route from discovery.
        if (response.status === 404) return { ...lock, responsive: false };
        const info = response.ok ? ((await response.json()) as { pid?: unknown }) : null;
        if (info?.pid === lock.pid) return { ...lock, responsive: true };
      } catch (error) {
        if (!connectionRefused(error)) return { ...lock, responsive: false };
      }
      removeLockfile(lock.pid, options.home);
      return null;
    }),
  );
  return checked.filter((instance): instance is VerifiedInstance => instance !== null);
}

// Signals that end the process without running the caller's own cleanup.
const FATAL_SIGNALS = { SIGHUP: 1, SIGTERM: 15 } as const;

/**
 * Remove this process's lockfile however the process ends: a normal exit, a
 * closed terminal (SIGHUP) or a kill (SIGTERM). Only SIGKILL and a crash of
 * the runtime get past it, and `listVerifiedInstances` deals with what they
 * leave. Returns a function that takes the handlers off again.
 */
export function removeLockfileOnExit(pid: number, home?: string): () => void {
  const remove = () => removeLockfile(pid, home);
  const handlers = Object.entries(FATAL_SIGNALS).map(([signal, number]) => {
    const handler = () => {
      remove();
      // A listener keeps the signal from ending the process, so end it here,
      // with the exit code a shell reports for that signal.
      process.exit(128 + number);
    };
    process.once(signal, handler);
    return [signal, handler] as const;
  });
  process.once('exit', remove);
  return () => {
    process.off('exit', remove);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}
