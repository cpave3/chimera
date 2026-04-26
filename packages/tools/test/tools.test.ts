import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTools } from '../src/build';
import { LocalExecutor } from '../src/local-executor';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };

describe('buildTools', () => {
  let root: string;
  let executor: LocalExecutor;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-tools-'));
    executor = new LocalExecutor({ cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function tools() {
    return buildTools({
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
    }).tools as unknown as Record<string, AnyTool>;
  }

  it('returns exactly bash, read, write, edit', () => {
    const toolset = tools();
    expect(Object.keys(toolset).sort()).toEqual(['bash', 'edit', 'read', 'write']);
  });

  it('bash runs the command and returns stdout', async () => {
    const toolset = tools();
    const result = await toolset.bash!.execute({ command: 'echo hi' }, {});
    expect(result.stdout).toContain('hi');
    expect(result.exit_code).toBe(0);
  });

  it('bash refuses destructive patterns without running them', async () => {
    const toolset = tools();
    const result = await toolset.bash!.execute({ command: 'rm -rf /' }, {});
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/destructive/i);
  });

  it('read returns line-number-prefixed content and total_lines', async () => {
    await writeFile(join(root, 'f.txt'), 'alpha\nbeta\ngamma\n');
    const toolset = tools();
    const result = await toolset.read!.execute({ path: 'f.txt' }, {});
    expect(result.total_lines).toBe(3);
    expect(result.content.split('\n')).toEqual(['1\talpha', '2\tbeta', '3\tgamma']);
    expect(result.truncated).toBe(false);
  });

  it('read honors start_line and end_line', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile(join(root, 'big.txt'), lines);
    const toolset = tools();
    const result = await toolset.read!.execute({ path: 'big.txt', start_line: 5, end_line: 7 }, {});
    expect(result.content.split('\n')).toEqual(['5\tline5', '6\tline6', '7\tline7']);
  });

  it('read truncates past 2000 lines', async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `l${i}`).join('\n');
    await writeFile(join(root, 'huge.txt'), lines);
    const toolset = tools();
    const result = await toolset.read!.execute({ path: 'huge.txt' }, {});
    expect(result.total_lines).toBe(2500);
    expect(result.truncated).toBe(true);
  });

  it('write creates files and reports bytes', async () => {
    const toolset = tools();
    const result = await toolset.write!.execute({ path: 'new.txt', content: 'hello' }, {});
    expect(result.created).toBe(true);
    expect(result.bytes_written).toBe(5);
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('hello');
  });

  it('write reports created=false when overwriting', async () => {
    await writeFile(join(root, 'e.txt'), 'old');
    const toolset = tools();
    const result = await toolset.write!.execute({ path: 'e.txt', content: 'new' }, {});
    expect(result.created).toBe(false);
  });

  it('edit succeeds on a unique match', async () => {
    await writeFile(join(root, 'f.txt'), 'hello world');
    const toolset = tools();
    const result = await toolset.edit!.execute(
      { path: 'f.txt', old_string: 'world', new_string: 'chimera' },
      {},
    );
    expect(result.replacements).toBe(1);
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('hello chimera');
  });

  it('edit throws on not-found', async () => {
    await writeFile(join(root, 'f.txt'), 'abc');
    const toolset = tools();
    await expect(
      toolset.edit!.execute({ path: 'f.txt', old_string: 'xyz', new_string: 'foo' }, {}),
    ).rejects.toThrow(/not found/);
  });

  it('edit throws on ambiguous match unless replace_all', async () => {
    await writeFile(join(root, 'f.txt'), 'a\na\na');
    const toolset = tools();
    await expect(
      toolset.edit!.execute({ path: 'f.txt', old_string: 'a', new_string: 'b' }, {}),
    ).rejects.toThrow(/3 occurrences/);
    const result = await toolset.edit!.execute(
      { path: 'f.txt', old_string: 'a', new_string: 'b', replace_all: true },
      {},
    );
    expect(result.replacements).toBe(3);
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('b\nb\nb');
  });
});
