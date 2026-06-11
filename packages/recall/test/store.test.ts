import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecallStore } from '../src/store';

const SESSION_ID = '01TESTRECALL00000000000000';

describe('RecallStore', () => {
  let home: string;
  let store: RecallStore;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-recall-'));
    store = new RecallStore({ sessionId: SESSION_ID, home });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('put returns a deterministic pr_ id and get round-trips the entry', async () => {
    const first = await store.put({
      toolName: 'bash',
      args: { command: 'ls -la' },
      content: 'file1\nfile2\n',
    });
    expect(first.id).toMatch(/^pr_[0-9a-f]{8}$/);

    const again = await store.put({
      toolName: 'bash',
      args: { command: 'ls -la' },
      content: 'file1\nfile2\n',
    });
    expect(again.id).toBe(first.id);

    const fetched = await store.get(first.id);
    expect(fetched?.content).toBe('file1\nfile2\n');
    expect(fetched?.toolName).toBe('bash');
  });

  it('same args with different content produce different ids', async () => {
    const a = await store.put({ toolName: 'read', args: { path: 'x' }, content: 'version one' });
    const b = await store.put({ toolName: 'read', args: { path: 'x' }, content: 'version two' });
    expect(a.id).not.toBe(b.id);
    expect((await store.get(a.id))?.content).toBe('version one');
    expect((await store.get(b.id))?.content).toBe('version two');
  });

  it('canonicalizes args key order into the same id', async () => {
    const a = await store.put({ toolName: 't', args: { x: 1, y: 2 }, content: 'c' });
    const b = await store.put({ toolName: 't', args: { y: 2, x: 1 }, content: 'c' });
    expect(a.id).toBe(b.id);
  });

  it('get returns null for unknown ids', async () => {
    expect(await store.get('pr_deadbeef')).toBeNull();
  });

  it('purges entries older than ttlDays on write', async () => {
    const old = await store.put({ toolName: 'bash', args: { command: 'old' }, content: 'old out' });
    const dir = join(home, '.chimera', 'recall', SESSION_ID);
    const oldPath = join(dir, `${old.id}.json`);
    const fortyDaysAgo = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    await utimes(oldPath, fortyDaysAgo, fortyDaysAgo);

    const fresh = new RecallStore({ sessionId: SESSION_ID, home, ttlDays: 30 });
    await fresh.put({ toolName: 'bash', args: { command: 'new' }, content: 'new out' });

    const remaining = await readdir(dir);
    expect(remaining).toHaveLength(1);
    expect(await fresh.get(old.id)).toBeNull();
  });

  it('does not create the session dir until first write', async () => {
    const dir = join(home, '.chimera', 'recall', SESSION_ID);
    expect(await stat(dir).catch(() => null)).toBeNull();
    expect(await store.get('pr_00000000')).toBeNull();
    expect(await stat(dir).catch(() => null)).toBeNull();
  });

  it('removeSession deletes the whole store directory', async () => {
    await store.put({ toolName: 'bash', args: {}, content: 'x' });
    await RecallStore.removeSession(SESSION_ID, home);
    const dir = join(home, '.chimera', 'recall', SESSION_ID);
    expect(await stat(dir).catch(() => null)).toBeNull();
  });
});
