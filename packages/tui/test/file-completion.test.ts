import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptCompletion,
  completionContext,
  listProjectFiles,
  rankFiles,
} from '../src/file-completion';

describe('completionContext', () => {
  const at = (text: string, cursor = text.length) => completionContext({ text, cursor });

  it('finds the @ word under the cursor', () => {
    expect(at('fix @agen')).toEqual({ marker: '@', query: 'agen', start: 4, end: 9 });
  });

  it('finds a # word for write access', () => {
    expect(at('update #src/ind')).toMatchObject({ marker: '#', query: 'src/ind' });
  });

  it('opens with an empty query right after the marker', () => {
    expect(at('see @')).toMatchObject({ marker: '@', query: '' });
  });

  it('ignores a marker inside a word, a markdown heading and a finished word', () => {
    expect(at('mail me@example')).toBeNull();
    expect(at('## Title')).toBeNull();
    expect(at('fix @agent.ts now')).toBeNull();
  });

  it('uses the word the cursor is in, not the last one', () => {
    expect(at('fix @age and @eve', 8)).toMatchObject({ query: 'age', start: 4, end: 8 });
  });
});

describe('rankFiles', () => {
  const files = [
    'packages/core/src/agent.ts',
    'packages/core/test/agent.test.ts',
    'packages/server/src/agent-registry.ts',
    'packages/core/src/events.ts',
    'docs/management.md',
    'README.md',
  ];

  it('puts a file whose name starts with the query first, shorter paths first', () => {
    expect(rankFiles(files, 'agent', 3)).toEqual([
      'packages/core/src/agent.ts',
      'packages/core/test/agent.test.ts',
      'packages/server/src/agent-registry.ts',
    ]);
  });

  it('matches a name in the middle and then a directory', () => {
    expect(rankFiles(files, 'registry', 5)).toEqual(['packages/server/src/agent-registry.ts']);
    expect(rankFiles(files, 'server', 5)).toEqual(['packages/server/src/agent-registry.ts']);
  });

  it('falls back to letters in order', () => {
    expect(rankFiles(files, 'coev', 5)).toEqual(['packages/core/src/events.ts']);
    expect(rankFiles(files, 'zzz', 5)).toEqual([]);
  });

  it('ignores case and returns the shortest paths for an empty query', () => {
    expect(rankFiles(files, 'readme', 5)).toEqual(['README.md']);
    expect(rankFiles(files, '', 2)).toEqual(['README.md', 'docs/management.md']);
  });
});

describe('acceptCompletion', () => {
  it('replaces the word with the marker, the path and a space', () => {
    const buffer = { text: 'fix @agen now', cursor: 9 };
    const context = completionContext(buffer)!;

    expect(acceptCompletion(buffer, context, 'packages/core/src/agent.ts')).toEqual({
      text: 'fix @packages/core/src/agent.ts  now',
      cursor: 32,
    });
  });

  it('quotes a path with spaces so it stays one attachment', () => {
    const buffer = { text: '#dai', cursor: 4 };
    const context = completionContext(buffer)!;

    expect(acceptCompletion(buffer, context, 'Daily Notes/today.md')).toEqual({
      text: '#"Daily Notes/today.md" ',
      cursor: 24,
    });
  });
});

describe('listProjectFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-files-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), '');
    await writeFile(join(root, 'README.md'), '');
    await writeFile(join(root, 'node_modules', 'dep', 'index.js'), '');
    await writeFile(join(root, 'ignored.log'), '');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists tracked and untracked files of a git repository, honouring .gitignore', async () => {
    await writeFile(join(root, '.gitignore'), 'node_modules\n*.log\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', 'README.md'], { cwd: root });

    expect((await listProjectFiles(root)).sort()).toEqual(['.gitignore', 'README.md', 'src/a.ts']);
  });

  it('walks the directory outside a git repository, skipping dependency folders', async () => {
    expect((await listProjectFiles(root)).sort()).toEqual(['README.md', 'ignored.log', 'src/a.ts']);
  });
});
