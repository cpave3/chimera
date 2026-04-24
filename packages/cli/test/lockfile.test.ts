import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPidAlive, listLiveInstances, lockfilePath, writeLockfile } from '../src/lockfile';

describe('lockfile', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-lock-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('isPidAlive returns true for current pid and false for a fake one', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // PID 2**30 is almost certainly unused.
    expect(isPidAlive(2 ** 30)).toBe(false);
  });

  it('writeLockfile creates the file and listLiveInstances returns it', () => {
    writeLockfile(
      {
        pid: process.pid,
        port: 12345,
        cwd: '/tmp',
        startedAt: Date.now(),
        version: '0.1.0',
        url: 'http://127.0.0.1:12345',
      },
      home,
    );
    expect(existsSync(lockfilePath(process.pid, home))).toBe(true);
    const instances = listLiveInstances(home);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.port).toBe(12345);
  });

  it('listLiveInstances cleans up stale lockfiles', () => {
    // Write a lockfile for a dead pid.
    writeLockfile(
      {
        pid: 2 ** 30,
        port: 999,
        cwd: '/tmp',
        startedAt: Date.now(),
        version: '0.1.0',
        url: 'http://127.0.0.1:999',
      },
      home,
    );
    expect(existsSync(lockfilePath(2 ** 30, home))).toBe(true);
    const instances = listLiveInstances(home);
    expect(instances).toHaveLength(0);
    expect(existsSync(lockfilePath(2 ** 30, home))).toBe(false);
  });
});
