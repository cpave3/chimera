import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLockfile } from '../src/lockfile';
import { resolveAttachTarget } from '../src/commands/attach';

describe('resolveAttachTarget', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-attach-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('resolves a URL directly', () => {
    const result = resolveAttachTarget('http://127.0.0.1:9999', home);
    expect(result.url).toBe('http://127.0.0.1:9999');
    expect(result.sessionId).toBeUndefined();
  });

  it('resolves by PID match', () => {
    writeLockfile(
      {
        pid: process.pid,
        port: 9999,
        cwd: '/tmp',
        sessionId: 'sess-abc' as never,
        startedAt: Date.now(),
        version: '0.1.0',
        url: 'http://127.0.0.1:9999',
      },
      home,
    );
    const result = resolveAttachTarget(String(process.pid), home);
    expect(result.url).toBe('http://127.0.0.1:9999');
    expect(result.sessionId).toBe('sess-abc');
  });

  it('resolves by session ID prefix', () => {
    writeLockfile(
      {
        pid: process.pid,
        port: 8888,
        cwd: '/tmp',
        sessionId: '01JYM6GJTQHMTQ34GJSCD83XD0' as never,
        startedAt: Date.now(),
        version: '0.1.0',
        url: 'http://127.0.0.1:8888',
      },
      home,
    );
    const result = resolveAttachTarget('01JYM6GJTQ', home);
    expect(result.url).toBe('http://127.0.0.1:8888');
    expect(result.sessionId).toBe('01JYM6GJTQHMTQ34GJSCD83XD0');
  });

  it('throws when no instance matches', () => {
    expect(() => resolveAttachTarget('nonexistent', home)).toThrow(/No running instance matches/);
  });
});
