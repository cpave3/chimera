import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTools } from '../src/build';
import type { ToolContext } from '../src/context';
import { LocalExecutor } from '../src/local-executor';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };

const GIT_AVAILABLE = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const describeIfGit = GIT_AVAILABLE ? describe : describe.skip;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

describeIfGit('git tool', () => {
  let root: string;
  let first: string;
  let second: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-git-'));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(root, 'file.txt'), 'one\n');
    git(root, 'add', 'file.txt');
    git(root, 'commit', '-q', '-m', 'first commit');
    first = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '-b', 'topic');
    await writeFile(join(root, 'file.txt'), 'one\ntwo\n');
    git(root, 'commit', '-q', '-am', 'second commit');
    second = git(root, 'rev-parse', 'HEAD');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function gitTool(context: Partial<ToolContext> = {}): AnyTool {
    const executor = new LocalExecutor({ cwd: root });
    const tools = buildTools({
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
      ...context,
    }).tools as unknown as Record<string, AnyTool>;
    return tools.git!;
  }

  it('lists the commits between two revisions', async () => {
    const result = await gitTool().execute({
      subcommand: 'log',
      args: ['--format=%s', `${first}..${second}`],
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe('second commit');
  });

  it('runs each listed read', async () => {
    const tool = gitTool();
    const run = (subcommand: string, ...args: string[]) => tool.execute({ subcommand, args });

    expect((await run('show', '--format=%s', '--stat', second)).stdout).toContain('second commit');
    expect((await run('diff', first, second)).stdout).toContain('+two');
    expect((await run('rev-parse', 'HEAD')).stdout.trim()).toBe(second);
    expect((await run('merge-base', 'main', 'topic')).stdout.trim()).toBe(first);
    await writeFile(join(root, 'untracked.txt'), 'x');
    expect((await run('status', '--porcelain')).stdout).toContain('?? untracked.txt');
    expect((await run('branch', '--contains', first)).stdout).toMatch(/main[\s\S]*topic/);
    expect((await run('cat-file', '-p', `${first}:file.txt`)).stdout).toBe('one\n');
  });

  function repoState(): string {
    return [
      git(root, 'rev-parse', 'HEAD'),
      git(root, 'symbolic-ref', 'HEAD'),
      git(root, 'for-each-ref'),
      git(root, 'config', '--list', '--local'),
      git(root, 'stash', 'list'),
      git(root, 'status', '--porcelain'),
    ].join('\n');
  }

  it.each([
    ['commit', ['--allow-empty', '-q', '-m', 'x']],
    ['push', ['-q', '.', 'topic:pushed']],
    ['checkout', ['-q', 'main']],
    ['reset', ['-q', '--hard', 'main']],
    ['config', ['user.name', 'Changed']],
    ['fetch', ['-q', '.', 'main:fetched']],
    ['tag', ['v1']],
    ['stash', ['push', '-q']],
  ])('refuses the %s subcommand and leaves the repository unchanged', async (subcommand, args) => {
    await writeFile(join(root, 'file.txt'), 'dirty\n');
    const before = repoState();
    const result = await gitTool().execute({ subcommand, args });
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/^refused by chimera: /);
    expect(repoState()).toBe(before);
  });

  it.each([
    ['log', ['--output=OUT']],
    ['diff', ['--outp=OUT', 'main', 'topic']],
    ['show', ['--output', 'OUT']],
    ['log', ['-p', '--o=OUT']],
  ])('refuses %s %j, which would write a file', async (subcommand, args) => {
    const out = join(root, 'written.txt');
    const result = await gitTool().execute({
      subcommand,
      args: args.map((arg) => arg.replace('OUT', out)),
    });
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/^refused by chimera: /);
    expect(existsSync(out)).toBe(false);
  });

  it.each([
    ['diff', ['--ext-diff', 'main', 'topic']],
    ['show', ['--textconv', 'HEAD']],
    ['cat-file', ['--filters', 'HEAD:file.txt']],
    ['cat-file', ['--textconv', 'HEAD:file.txt']],
    ['diff', ['--no-index', '/etc/hostname', 'file.txt']],
    ['log', ['-C', '/']],
    ['log', ['-c', 'core.pager=touch pwned']],
    ['log', ['--git-dir=/tmp']],
    ['rev-parse', ['--work-tree', '/tmp']],
  ])('refuses %s %j', async (subcommand, args) => {
    const result = await gitTool().execute({ subcommand, args });
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/^refused by chimera: /);
  });

  describe('paths outside the working directory', () => {
    let outside: string;

    beforeEach(async () => {
      outside = await mkdtemp(join(tmpdir(), 'chimera-git-outside-'));
      await writeFile(join(outside, 'secret.txt'), 'secret\n');
      await symlink(outside, join(root, 'link'));
    });

    afterEach(async () => {
      await rm(outside, { recursive: true, force: true });
    });

    const shapes = {
      absolute: () => join(outside, 'secret.txt'),
      'leaving the cwd': () => '../secret.txt',
      'through a symlink': () => 'link/secret.txt',
    };

    it.each([
      ['log', (path: string) => ['--', path]],
      ['show', (path: string) => ['HEAD', '--', path]],
      ['diff', (path: string) => [path, 'file.txt']],
      ['status', (path: string) => ['--', path]],
      ['rev-parse', (path: string) => ['--resolve-git-dir', path]],
    ] as const)('refuses %s with a path outside the working directory', async (subcommand, argsFor) => {
      for (const [shape, path] of Object.entries(shapes)) {
        const result = await gitTool().execute({ subcommand, args: argsFor(path()) });
        expect(result.exit_code, shape).toBe(-1);
        expect(result.stderr, shape).toMatch(
          /^refused by chimera: .*outside the working directory/,
        );
      }
    });

    it('accepts a path inside the working directory', async () => {
      const result = await gitTool().execute({
        subcommand: 'log',
        args: ['--format=%s', '--', 'file.txt'],
      });
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain('second commit');
    });
  });

  it('diffs a revision range', async () => {
    const result = await gitTool().execute({ subcommand: 'diff', args: ['main..topic'] });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('+two');
  });

  it('does not check the paths after a literal --', async () => {
    await writeFile(join(root, '--output'), 'odd name\n');
    git(root, 'add', '--', '--output');
    git(root, 'commit', '-q', '-m', 'odd file');
    const result = await gitTool().execute({
      subcommand: 'log',
      args: ['--format=%s', '--', '--output'],
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe('odd file');
  });

  it('keeps shell metacharacters literal', async () => {
    for (const arg of ['; touch pwned', '$(touch pwned)', '`touch pwned`', 'x | touch pwned']) {
      await gitTool().execute({ subcommand: 'log', args: [arg] });
    }
    expect(existsSync(join(root, 'pwned'))).toBe(false);
  });

  it('accepts an exact option that is also a prefix of a refused one', async () => {
    const result = await gitTool().execute({ subcommand: 'diff', args: ['--text', first, second] });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('+two');
  });

  it.each([
    [['newname']],
    [['-D', 'topic']],
    [['-m', 'renamed']],
    [['--contains', 'HEAD', '-d', 'topic']],
    [['--set-upstream-to=main']],
    [['--list', '--', 'x']],
    [['--', 'x']],
  ])('refuses branch %j and leaves the branches unchanged', async (args) => {
    const before = git(root, 'for-each-ref');
    const result = await gitTool().execute({ subcommand: 'branch', args });
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/^refused by chimera: /);
    expect(git(root, 'for-each-ref')).toBe(before);
  });

  it.each([
    [['--list'], 'main'],
    [['-av'], 'topic'],
    [['--merged', 'topic', '--format=%(refname:short)'], 'main'],
    [['--show-current'], 'topic'],
    [['--contains', 'HEAD', 'newname'], ''],
  ])('lists branches with branch %j', async (args, expected) => {
    const before = git(root, 'for-each-ref');
    const result = await gitTool().execute({ subcommand: 'branch', args });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(git(root, 'for-each-ref')).toBe(before);
  });

  it('runs status without rewriting the index', async () => {
    const index = join(root, '.git', 'index');
    await writeFile(join(root, 'file.txt'), 'one\ntwo\n');
    const past = new Date(Date.now() - 60_000);
    await utimes(index, past, past);
    const before = (await stat(index)).mtimeMs;

    const result = await gitTool().execute({ subcommand: 'status' });

    expect(result.exit_code).toBe(0);
    expect((await stat(index)).mtimeMs).toBe(before);
  });

  it('never runs a program the repository config names', async () => {
    const marker = join(root, 'ran');
    const script = join(root, 'program.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\ncat "$1" 2>/dev/null\n`);
    await chmod(script, 0o755);
    await writeFile(join(root, 'post-index-change'), `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(join(root, 'post-index-change'), 0o755);
    git(root, 'config', 'diff.external', script);
    git(root, 'config', 'diff.conv.textconv', script);
    git(root, 'config', 'core.fsmonitor', script);
    git(root, 'config', 'core.hooksPath', root);
    await writeFile(join(root, '.gitattributes'), '*.txt diff=conv\n');
    await writeFile(join(root, 'file.txt'), 'changed\n');

    const tool = gitTool();
    await tool.execute({ subcommand: 'diff' });
    await tool.execute({ subcommand: 'log', args: ['-p'] });
    await tool.execute({ subcommand: 'show', args: [`${second}:file.txt`] });
    await tool.execute({ subcommand: 'status' });

    expect(existsSync(marker)).toBe(false);
  });

  it("reads the working directory's repository whatever GIT_DIR it inherits", async () => {
    const other = await mkdtemp(join(tmpdir(), 'chimera-git-other-'));
    git(other, 'init', '-q');
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    try {
      const result = await gitTool().execute({ subcommand: 'rev-parse', args: ['HEAD'] });
      expect(result.stdout.trim()).toBe(second);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.tree;
      await rm(other, { recursive: true, force: true });
    }
  });

  it('cuts a large output and says how to narrow it', async () => {
    await writeFile(join(root, 'big.txt'), `${'x'.repeat(99)}\n`.repeat(4000));
    git(root, 'add', 'big.txt');
    git(root, 'commit', '-q', '-m', 'big');

    const result = await gitTool().execute({ subcommand: 'show', args: ['HEAD:big.txt'] });

    expect(result.exit_code).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(300_000);
    expect(result.stdout).toMatch(/\[git: output cut at \d+ characters\. Narrow it/);
  });

  it('does not mark a small output as cut', async () => {
    const result = await gitTool().execute({ subcommand: 'rev-parse', args: ['HEAD'] });
    expect(result.truncated).toBeUndefined();
  });

  it('runs every read without asking the permission gate', async () => {
    const request = vi.fn(async () => ({ decision: 'deny' as const }));
    const tool = gitTool({
      permissionGate: { request } as unknown as ToolContext['permissionGate'],
    });

    const reads: Array<[string, string[]]> = [
      ['log', ['--oneline']],
      ['show', ['HEAD']],
      ['diff', [first, second]],
      ['rev-parse', ['HEAD']],
      ['merge-base', ['main', 'topic']],
      ['status', []],
      ['branch', ['--contains', first]],
      ['cat-file', ['-t', 'HEAD']],
    ];
    for (const [subcommand, args] of reads) {
      expect((await tool.execute({ subcommand, args })).exit_code).toBe(0);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('runs git with terminal prompts and optional locks off', async () => {
    const executor = new LocalExecutor({ cwd: root });
    const exec = vi.spyOn(executor, 'exec');
    const tools = buildTools({
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
    }).tools as unknown as Record<string, AnyTool>;

    await tools.git!.execute({ subcommand: 'status' });

    expect(exec.mock.calls[0]![1]?.env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    });
  });
});
