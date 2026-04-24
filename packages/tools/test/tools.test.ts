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
    }) as unknown as Record<string, AnyTool>;
  }

  it('returns exactly bash, read, write, edit', () => {
    const t = tools();
    expect(Object.keys(t).sort()).toEqual(['bash', 'edit', 'read', 'write']);
  });

  it('bash runs the command and returns stdout', async () => {
    const t = tools();
    const r = await t.bash!.execute({ command: 'echo hi' }, {});
    expect(r.stdout).toContain('hi');
    expect(r.exit_code).toBe(0);
  });

  it('bash refuses destructive patterns without running them', async () => {
    const t = tools();
    const r = await t.bash!.execute({ command: 'rm -rf /' }, {});
    expect(r.exit_code).toBe(-1);
    expect(r.stderr).toMatch(/destructive/i);
  });

  it('read returns line-number-prefixed content and total_lines', async () => {
    await writeFile(join(root, 'f.txt'), 'alpha\nbeta\ngamma\n');
    const t = tools();
    const r = await t.read!.execute({ path: 'f.txt' }, {});
    expect(r.total_lines).toBe(3);
    expect(r.content.split('\n')).toEqual(['1\talpha', '2\tbeta', '3\tgamma']);
    expect(r.truncated).toBe(false);
  });

  it('read honors start_line and end_line', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile(join(root, 'big.txt'), lines);
    const t = tools();
    const r = await t.read!.execute({ path: 'big.txt', start_line: 5, end_line: 7 }, {});
    expect(r.content.split('\n')).toEqual(['5\tline5', '6\tline6', '7\tline7']);
  });

  it('read truncates past 2000 lines', async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `l${i}`).join('\n');
    await writeFile(join(root, 'huge.txt'), lines);
    const t = tools();
    const r = await t.read!.execute({ path: 'huge.txt' }, {});
    expect(r.total_lines).toBe(2500);
    expect(r.truncated).toBe(true);
  });

  it('write creates files and reports bytes', async () => {
    const t = tools();
    const r = await t.write!.execute({ path: 'new.txt', content: 'hello' }, {});
    expect(r.created).toBe(true);
    expect(r.bytes_written).toBe(5);
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('hello');
  });

  it('write reports created=false when overwriting', async () => {
    await writeFile(join(root, 'e.txt'), 'old');
    const t = tools();
    const r = await t.write!.execute({ path: 'e.txt', content: 'new' }, {});
    expect(r.created).toBe(false);
  });

  it('edit succeeds on a unique match', async () => {
    await writeFile(join(root, 'f.txt'), 'hello world');
    const t = tools();
    const r = await t.edit!.execute(
      { path: 'f.txt', old_string: 'world', new_string: 'chimera' },
      {},
    );
    expect(r.replacements).toBe(1);
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('hello chimera');
  });

  it('edit throws on not-found', async () => {
    await writeFile(join(root, 'f.txt'), 'abc');
    const t = tools();
    await expect(
      t.edit!.execute({ path: 'f.txt', old_string: 'xyz', new_string: 'foo' }, {}),
    ).rejects.toThrow(/not found/);
  });

  it('edit throws on ambiguous match unless replace_all', async () => {
    await writeFile(join(root, 'f.txt'), 'a\na\na');
    const t = tools();
    await expect(
      t.edit!.execute({ path: 'f.txt', old_string: 'a', new_string: 'b' }, {}),
    ).rejects.toThrow(/3 occurrences/);
    const r = await t.edit!.execute(
      { path: 'f.txt', old_string: 'a', new_string: 'b', replace_all: true },
      {},
    );
    expect(r.replacements).toBe(3);
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('b\nb\nb');
  });
});
