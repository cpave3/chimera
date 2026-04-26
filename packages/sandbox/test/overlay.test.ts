import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyOverlay,
  diffOverlay,
  discardOverlay,
  ensureOverlayDirs,
  forkOverlay,
  parseRsyncItemize,
  removeOverlayDirs,
} from '../src/overlay';

const SESSION = 'sess-overlay-test';

let overlaysHome: string;
let hostCwd: string;

beforeEach(async () => {
  overlaysHome = await mkdtemp(join(tmpdir(), 'chimera-overlays-'));
  hostCwd = await mkdtemp(join(tmpdir(), 'chimera-cwd-'));
});

afterEach(async () => {
  await rm(overlaysHome, { recursive: true, force: true });
  await rm(hostCwd, { recursive: true, force: true });
});

describe('parseRsyncItemize', () => {
  it('classifies added/modified/deleted entries', () => {
    const sample = [
      '>f+++++++++ new.txt',
      '>f.st...... modified.ts',
      '*deleting old.md',
      'cd+++++++++ subdir/',
      '.d..t...... existing-dir/',
    ].join('\n');
    const diff = parseRsyncItemize(sample);
    expect(diff.added).toEqual(['new.txt']);
    expect(diff.modified).toEqual(['modified.ts']);
    expect(diff.deleted).toEqual(['old.md']);
  });

  it('ignores blank lines', () => {
    const diff = parseRsyncItemize('\n\n');
    expect(diff).toEqual({ modified: [], added: [], deleted: [] });
  });
});

describe('diffOverlay / applyOverlay', () => {
  it('feeds the upper data dir and host cwd to rsync --dry-run', async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        stdout: '>f+++++++++ a.ts\n>f.st...... b.ts\n*deleting c.ts\n',
        stderr: '',
        exitCode: 0,
      }),
    };
    const diff = await diffOverlay(SESSION, hostCwd, { overlaysHome, runner });
    expect(diff).toEqual({ added: ['a.ts'], modified: ['b.ts'], deleted: ['c.ts'] });
    const args = runner.run.mock.calls[0]![0] as string[];
    expect(args).toContain('--dry-run');
    expect(args).toContain('--delete');
    expect(args).toContain('--itemize-changes');
    expect(args[args.length - 2]).toMatch(/\/upper\/data\/$/);
    expect(args[args.length - 1]).toBe(`${hostCwd}/`);
  });

  it('throws on non-zero rsync exit', async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 23 }),
    };
    await expect(diffOverlay(SESSION, hostCwd, { overlaysHome, runner })).rejects.toThrow(
      /rsync diff failed/,
    );
  });

  it('apply with selected paths emits matching --include / --exclude', async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };
    await applyOverlay(
      SESSION,
      hostCwd,
      { paths: ['src/a.ts', 'b.ts'] },
      { overlaysHome, runner },
    );
    const args = runner.run.mock.calls[0]![0] as string[];
    expect(args.slice(0, 2)).toEqual(['-a', '--delete']);
    expect(args).toContain('--include');
    expect(args.filter((a) => a === '--include').length).toBeGreaterThanOrEqual(2);
    expect(args[args.length - 2]).toMatch(/\/upper\/data\/$/);
    expect(args[args.length - 1]).toBe(`${hostCwd}/`);
    // Selected ancestor includes are present.
    const includes = args
      .map((a, i) => (a === '--include' ? args[i + 1] : null))
      .filter((x): x is string => x !== null);
    expect(includes).toContain('/src/');
    expect(includes).toContain('/src/a.ts');
    expect(includes).toContain('/b.ts');
  });

  it('apply without paths uses full sync', async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };
    await applyOverlay(SESSION, hostCwd, {}, { overlaysHome, runner });
    const args = runner.run.mock.calls[0]![0] as string[];
    expect(args).not.toContain('--include');
    expect(args).not.toContain('--exclude');
  });
});

describe('overlay dir lifecycle', () => {
  it('ensureOverlayDirs creates upper/data and work', async () => {
    await ensureOverlayDirs(SESSION, overlaysHome);
    const upper = await stat(join(overlaysHome, SESSION, 'upper', 'data'));
    const work = await stat(join(overlaysHome, SESSION, 'work'));
    expect(upper.isDirectory()).toBe(true);
    expect(work.isDirectory()).toBe(true);
  });

  it('discardOverlay removes the upperdir tree', async () => {
    await ensureOverlayDirs(SESSION, overlaysHome);
    await discardOverlay(SESSION, { overlaysHome });
    await expect(stat(join(overlaysHome, SESSION))).rejects.toThrow();
  });

  it('removeOverlayDirs is idempotent', async () => {
    await mkdir(join(overlaysHome, SESSION), { recursive: true });
    await removeOverlayDirs(SESSION, overlaysHome);
    await removeOverlayDirs(SESSION, overlaysHome);
  });
});

describe('forkOverlay', () => {
  it("rsyncs from parent's upper to child's upper and creates child dirs", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };
    const parentId = 'parent-fork';
    const childId = 'child-fork';
    await ensureOverlayDirs(parentId, overlaysHome);
    await forkOverlay(parentId, childId, { overlaysHome, runner });
    const args = runner.run.mock.calls[0]![0] as string[];
    expect(args[0]).toBe('-a');
    expect(args[1]).toMatch(new RegExp(`/${parentId}/upper/$`));
    expect(args[2]).toMatch(new RegExp(`/${childId}/upper/$`));
    // Child dirs should exist
    const childUpper = await stat(join(overlaysHome, childId, 'upper', 'data'));
    expect(childUpper.isDirectory()).toBe(true);
  });

  it('tolerates exit 23 (parent had no overlay yet)', async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'no source',
        exitCode: 23,
      }),
    };
    await expect(
      forkOverlay('p', 'c', { overlaysHome, runner }),
    ).resolves.not.toThrow();
  });

  it('throws on other non-zero exit codes', async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'broken',
        exitCode: 12,
      }),
    };
    await expect(
      forkOverlay('p', 'c', { overlaysHome, runner }),
    ).rejects.toThrow(/forkOverlay/);
  });
});
