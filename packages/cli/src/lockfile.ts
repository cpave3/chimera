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
