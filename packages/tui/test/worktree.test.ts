import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorktree, readWorktree } from '../src/worktree';

const HASH = 'a'.repeat(40);

describe('parseWorktree', () => {
  it('reads the branch and how far it is ahead and behind', () => {
    const status = [
      `# branch.oid ${HASH}`,
      '# branch.head yg/json-flag',
      '# branch.upstream origin/yg/json-flag',
      '# branch.ab +1 -2',
    ].join('\n');

    expect(parseWorktree(status, '')).toEqual({
      branch: 'yg/json-flag',
      ahead: 1,
      behind: 2,
      files: [],
    });
  });

  it('lists changed files with the lines added and removed', () => {
    const status = [
      '# branch.head main',
      `1 .M N... 100644 100644 100644 ${HASH} ${HASH} src/yg/list.ts`,
      `1 A. N... 000000 100644 100644 ${HASH} ${HASH} src/yg/list.test.ts`,
      `1 D. N... 100644 000000 000000 ${HASH} ${HASH} old name.ts`,
      '? notes.md',
    ].join('\n');
    const numstat = [
      '18\t3\tsrc/yg/list.ts',
      '40\t0\tsrc/yg/list.test.ts',
      '0\t12\told name.ts',
    ].join('\n');

    expect(parseWorktree(status, numstat).files).toEqual([
      { path: 'src/yg/list.ts', status: 'M', added: 18, removed: 3 },
      { path: 'src/yg/list.test.ts', status: 'A', added: 40, removed: 0 },
      { path: 'old name.ts', status: 'D', added: 0, removed: 12 },
      { path: 'notes.md', status: 'A' },
    ]);
  });

  it('names a renamed file by its new path and an unmerged file as a conflict', () => {
    const status = [
      '# branch.head main',
      `2 R. N... 100644 100644 100644 ${HASH} ${HASH} R100 src/new.ts\tsrc/old.ts`,
      `u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} src/both.ts`,
    ].join('\n');

    expect(parseWorktree(status, '').files).toEqual([
      { path: 'src/new.ts', status: 'R' },
      { path: 'src/both.ts', status: 'U' },
    ]);
  });

  it('names a detached head by its commit', () => {
    const status = ['# branch.oid 0123456789abcdef0123', '# branch.head (detached)'].join('\n');
    expect(parseWorktree(status, '').branch).toBe('0123456');
  });

  it('leaves the counts out for a binary file', () => {
    const status = `1 .M N... 100644 100644 100644 ${HASH} ${HASH} logo.png`;
    expect(parseWorktree(status, '-\t-\tlogo.png').files).toEqual([
      { path: 'logo.png', status: 'M' },
    ]);
  });
});

describe('readWorktree', () => {
  it('reads a real repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chimera-worktree-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
    try {
      git('init', '-q', '-b', 'trunk');
      writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
      git('add', '.');
      git('commit', '-q', '-m', 'first');
      writeFileSync(join(root, 'a.txt'), 'one\n2\nthree\n');
      writeFileSync(join(root, 'b.txt'), 'new\n');

      expect(await readWorktree(root)).toEqual({
        branch: 'trunk',
        ahead: 0,
        behind: 0,
        files: [
          { path: 'a.txt', status: 'M', added: 2, removed: 1 },
          { path: 'b.txt', status: 'A' },
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers null outside a repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chimera-no-repo-'));
    try {
      expect(await readWorktree(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
