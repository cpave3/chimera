import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  projectIdFor,
  projectMemoryDir,
  readMemoryIndex,
  renderMemorySection,
  resolveProjectRoot,
} from '../src/project-memory';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'chimera-memory-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    stdio: 'pipe',
  });

describe('resolveProjectRoot', () => {
  it('is the repository root for a directory inside a repository', () => {
    const repo = join(root, 'app');
    mkdirSync(join(repo, 'packages', 'api'), { recursive: true });
    git(repo, 'init', '-q');

    expect(resolveProjectRoot(join(repo, 'packages', 'api'))).toBe(repo);
    expect(resolveProjectRoot(repo)).toBe(repo);
  });

  it('is the main working tree for a linked worktree, so all worktrees share one memory', () => {
    const repo = join(root, 'app');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    const worktree = join(root, 'app-task-1');
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'task-1');
    mkdirSync(join(worktree, 'src'), { recursive: true });

    expect(resolveProjectRoot(worktree)).toBe(repo);
    expect(resolveProjectRoot(join(worktree, 'src'))).toBe(repo);
  });

  it('is the directory itself outside a repository', () => {
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    expect(resolveProjectRoot(scratch)).toBe(scratch);
  });
});

describe('projectMemoryDir', () => {
  it('names the project by its path, under ~/.chimera/projects', () => {
    expect(projectIdFor('/home/u/code/app')).toBe('-home-u-code-app');
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);

    expect(projectMemoryDir(scratch, '/home/u')).toBe(
      join('/home/u', '.chimera', 'projects', projectIdFor(scratch), 'memory'),
    );
  });
});

describe('readMemoryIndex', () => {
  it('is null when nothing was saved yet', () => {
    expect(readMemoryIndex(join(root, 'none'))).toBeNull();
  });

  it('reads a short index whole', () => {
    writeFileSync(join(root, 'MEMORY.md'), '# Memory index\n\n- [Tests](tests.md) — use vitest\n');
    expect(readMemoryIndex(root)).toEqual({
      text: '# Memory index\n\n- [Tests](tests.md) — use vitest',
      omittedLines: 0,
    });
  });

  it('keeps the first 200 lines of a long index and counts the rest', () => {
    const lines = Array.from({ length: 350 }, (_, index) => `- [m${index}](m${index}.md) — fact`);
    writeFileSync(join(root, 'MEMORY.md'), lines.join('\n'));

    const index = readMemoryIndex(root);

    expect(index?.text.split('\n')).toHaveLength(200);
    expect(index?.text.split('\n').at(-1)).toBe('- [m199](m199.md) — fact');
    expect(index?.omittedLines).toBe(150);
  });
});

describe('renderMemorySection', () => {
  const directory = '/home/u/.chimera/projects/-home-u-code-app/memory';
  const index = { text: '- [Tests](tests.md) — use vitest', omittedLines: 0 };

  it('gives the directory, the index and the layout of a memory', () => {
    const section = renderMemorySection({ directory, index, access: 'write', promptStyle: 'lean' });

    expect(section.startsWith('# Project memory')).toBe(true);
    expect(section).toContain(directory);
    expect(section).toContain('- [Tests](tests.md) — use vitest');
    expect(section).toMatch(/one line in `MEMORY\.md`/i);
  });

  it('tells a large model when to save on its own', () => {
    const section = renderMemorySection({ directory, index, access: 'write', promptStyle: 'lean' });
    expect(section).toMatch(/lasting preference/);
    expect(section).toMatch(/corrects your approach/);
    expect(section).toMatch(/Do not save/);
  });

  it('tells a small model to save only on request', () => {
    const section = renderMemorySection({
      directory,
      index,
      access: 'write',
      promptStyle: 'guided',
    });
    expect(section).toMatch(/only when the user asks/);
    expect(section).not.toMatch(/lasting preference/);
  });

  it('says so when nothing is saved yet, and when the index was cut', () => {
    expect(
      renderMemorySection({ directory, index: null, access: 'write', promptStyle: 'lean' }),
    ).toMatch(/Nothing is saved yet/);
    expect(
      renderMemorySection({
        directory,
        index: { text: 'x', omittedLines: 150 },
        access: 'write',
        promptStyle: 'lean',
      }),
    ).toMatch(/150 more lines/);
  });

  it('tells a subagent that the memory is read-only', () => {
    const section = renderMemorySection({ directory, index, access: 'read', promptStyle: 'lean' });
    expect(section).toMatch(/read-only/);
    expect(section).not.toMatch(/lasting preference/);
  });

  it('says that the files are out of reach in a sandbox', () => {
    const section = renderMemorySection({ directory, index, access: 'none', promptStyle: 'lean' });
    expect(section).toMatch(/cannot be reached/);
    expect(section).toContain('- [Tests](tests.md) — use vitest');
  });
});
