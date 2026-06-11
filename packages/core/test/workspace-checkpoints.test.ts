import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Checkpoint } from '../src/persistence';
import { WorkspaceCheckpoints } from '../src/workspace-checkpoints';

const SESSION_ID = '01TESTWORKSPACE00000000000';

function checkpoint(index: number, userMessage: string): Checkpoint {
  return { index, userMessage, toolCallSummary: '', truncateByteOffset: index * 100 };
}

describe('WorkspaceCheckpoints', () => {
  let home: string;
  let cwd: string;
  let workspace: WorkspaceCheckpoints;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-wchome-'));
    cwd = await mkdtemp(join(tmpdir(), 'chimera-wccwd-'));
    workspace = new WorkspaceCheckpoints({ sessionId: SESSION_ID, cwd, home });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('snapshots assign increasing ordinals and survive reconstruction', async () => {
    await writeFile(join(cwd, 'a.txt'), 'one');
    const first = await workspace.snapshot('first prompt');
    expect(first?.ordinal).toBe(1);
    expect(first?.commit).toMatch(/^[0-9a-f]{40}$/);

    const reopened = new WorkspaceCheckpoints({ sessionId: SESSION_ID, cwd, home });
    await writeFile(join(cwd, 'a.txt'), 'two');
    const second = await reopened.snapshot('second prompt');
    expect(second?.ordinal).toBe(2);
    expect(second?.commit).not.toBe(first?.commit);
  });

  it('restore returns the tree to the pre-message state, removing later files', async () => {
    await writeFile(join(cwd, 'a.txt'), 'original');
    await workspace.snapshot('first prompt');

    await writeFile(join(cwd, 'a.txt'), 'mutated');
    await writeFile(join(cwd, 'b.txt'), 'created later');
    await workspace.snapshot('second prompt');

    await writeFile(join(cwd, 'c.txt'), 'even later');

    const checkpoints = [
      checkpoint(0, ''),
      checkpoint(1, 'first prompt'),
      checkpoint(3, 'second prompt'),
    ];
    const restored = await workspace.restore(checkpoints[2]!, checkpoints);
    expect(restored).toBe(true);

    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('mutated');
    expect(await stat(join(cwd, 'b.txt')).catch(() => null)).not.toBeNull();
    expect(await stat(join(cwd, 'c.txt')).catch(() => null)).toBeNull();
  });

  it('restore to an earlier checkpoint unwinds intermediate snapshots', async () => {
    await writeFile(join(cwd, 'a.txt'), 'original');
    await workspace.snapshot('first prompt');
    await writeFile(join(cwd, 'a.txt'), 'mutated');
    await workspace.snapshot('second prompt');

    const checkpoints = [
      checkpoint(0, ''),
      checkpoint(1, 'first prompt'),
      checkpoint(3, 'second prompt'),
    ];
    const restored = await workspace.restore(checkpoints[1]!, checkpoints);
    expect(restored).toBe(true);
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('original');

    // The discarded timeline's snapshot records are dropped: re-sending a
    // prompt after rewind starts a fresh ordinal at the restore point.
    const next = await workspace.snapshot('first prompt (edited)');
    expect(next?.ordinal).toBe(1);
  });

  it('matches duplicate prompts by occurrence', async () => {
    await writeFile(join(cwd, 'a.txt'), 'state-1');
    await workspace.snapshot('same prompt');
    await writeFile(join(cwd, 'a.txt'), 'state-2');
    await workspace.snapshot('same prompt');
    await writeFile(join(cwd, 'a.txt'), 'state-3');

    const checkpoints = [
      checkpoint(0, ''),
      checkpoint(1, 'same prompt'),
      checkpoint(3, 'same prompt'),
    ];
    const restored = await workspace.restore(checkpoints[2]!, checkpoints);
    expect(restored).toBe(true);
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('state-2');
  });

  it('checkpoint 0 restores the tree from before the first message', async () => {
    await writeFile(join(cwd, 'a.txt'), 'pristine');
    await workspace.snapshot('first prompt');
    await writeFile(join(cwd, 'a.txt'), 'dirty');

    const checkpoints = [checkpoint(0, ''), checkpoint(1, 'first prompt')];
    const restored = await workspace.restore(checkpoints[0]!, checkpoints);
    expect(restored).toBe(true);
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('pristine');
  });

  it('restore returns false when no snapshot matches', async () => {
    const checkpoints = [checkpoint(0, ''), checkpoint(1, 'never snapshotted')];
    expect(await workspace.restore(checkpoints[1]!, checkpoints)).toBe(false);
  });

  it('does not snapshot files ignored by the project gitignore', async () => {
    await writeFile(join(cwd, '.gitignore'), 'ignored.log\n');
    await writeFile(join(cwd, 'kept.txt'), 'kept');
    await writeFile(join(cwd, 'ignored.log'), 'noise');
    await workspace.snapshot('first prompt');

    await writeFile(join(cwd, 'kept.txt'), 'changed');
    await writeFile(join(cwd, 'ignored.log'), 'changed noise');
    await workspace.snapshot('second prompt');

    const checkpoints = [
      checkpoint(0, ''),
      checkpoint(1, 'first prompt'),
      checkpoint(3, 'second prompt'),
    ];
    await workspace.restore(checkpoints[2]!, checkpoints);
    expect(await readFile(join(cwd, 'kept.txt'), 'utf8')).toBe('changed');
    // Ignored files are left alone by both snapshot and restore.
    expect(await readFile(join(cwd, 'ignored.log'), 'utf8')).toBe('changed noise');
  });
});
