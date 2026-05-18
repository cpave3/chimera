import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTools } from '../src/build';
import { LocalExecutor } from '../src/local-executor';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };

const RG_AVAILABLE = (() => {
  try {
    const result = spawnSync('rg', ['--version'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
})();

const describeIfRg = RG_AVAILABLE ? describe : describe.skip;

describeIfRg('glob and grep tools (require ripgrep)', () => {
  let root: string;
  let executor: LocalExecutor;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-glob-'));
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

  it('glob lists files matching a pattern', async () => {
    await writeFile(join(root, 'a.ts'), 'x');
    await writeFile(join(root, 'b.ts'), 'x');
    await writeFile(join(root, 'c.md'), 'x');
    const result = await tools().glob!.execute({ pattern: '*.ts' }, {});
    expect(result.files.sort()).toEqual(['./a.ts', './b.ts']);
    expect(result.truncated).toBe(false);
  });

  it('glob honors a recursive pattern under a path', async () => {
    await mkdir(join(root, 'pkg/sub'), { recursive: true });
    await writeFile(join(root, 'pkg/sub/x.ts'), 'x');
    await writeFile(join(root, 'pkg/y.md'), 'x');
    const result = await tools().glob!.execute({ pattern: '**/*.ts', path: 'pkg' }, {});
    expect(result.files).toEqual(['pkg/sub/x.ts']);
  });

  it('glob returns empty list for no matches without erroring', async () => {
    await writeFile(join(root, 'a.ts'), 'x');
    const result = await tools().glob!.execute({ pattern: '*.foo' }, {});
    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('grep returns matched lines with file and line number', async () => {
    await writeFile(join(root, 'a.ts'), 'first\nhello world\nthird\n');
    await writeFile(join(root, 'b.ts'), 'no match here\n');
    const result = await tools().grep!.execute({ pattern: 'hello' }, {});
    expect(result.mode).toBe('content');
    expect(result.matches).toEqual([{ file: './a.ts', line: 2, text: 'hello world' }]);
    expect(result.truncated).toBe(false);
  });

  it('grep with files_with_matches returns only paths', async () => {
    await writeFile(join(root, 'a.ts'), 'hello\n');
    await writeFile(join(root, 'b.ts'), 'hello\n');
    await writeFile(join(root, 'c.ts'), 'no\n');
    const result = await tools().grep!.execute({ pattern: 'hello', files_with_matches: true }, {});
    expect(result.mode).toBe('files');
    expect(result.files.sort()).toEqual(['./a.ts', './b.ts']);
  });

  it('grep with case_insensitive matches across cases', async () => {
    await writeFile(join(root, 'a.ts'), 'Hello\nHELLO\nhello\n');
    const result = await tools().grep!.execute({ pattern: 'hello', case_insensitive: true }, {});
    expect(result.matches.length).toBe(3);
  });

  it('grep with glob filter restricts files searched', async () => {
    await writeFile(join(root, 'a.ts'), 'target\n');
    await writeFile(join(root, 'a.md'), 'target\n');
    const result = await tools().grep!.execute({ pattern: 'target', glob: '*.md' }, {});
    expect(result.matches.map((m: { file: string }) => m.file)).toEqual(['./a.md']);
  });

  it('glob excludes blocklisted dirs like node_modules by default', async () => {
    await mkdir(join(root, 'node_modules/sub'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'node_modules/sub/a.ts'), 'x');
    await writeFile(join(root, 'src/c.ts'), 'x');
    const result = await tools().glob!.execute({ pattern: '**/*' }, {});
    expect(result.files).toContain('./src/c.ts');
    expect(result.files).not.toContain('./node_modules/sub/a.ts');
  });

  it('glob includes blocklisted dirs when no_blocklist is true', async () => {
    await mkdir(join(root, 'node_modules/sub'), { recursive: true });
    await writeFile(join(root, 'node_modules/sub/a.ts'), 'x');
    const result = await tools().glob!.execute({ pattern: '**/*', no_blocklist: true }, {});
    expect(result.files).toContain('./node_modules/sub/a.ts');
  });

  it('glob spills full results to output_file when truncated', async () => {
    for (let i = 0; i < 1005; i++) {
      await writeFile(join(root, `f${i}.ts`), 'x');
    }
    const result = await tools().glob!.execute({ pattern: '*.ts', output_file: 'spill.txt' }, {});
    expect(result.truncated).toBe(true);
    expect(result.spillFile).toBe('spill.txt');
    expect(result.files.length).toBe(1000);

    const spill = await executor.readFile('spill.txt');
    const spilled = spill.split('\n').filter((l) => l.length > 0);
    expect(spilled.length).toBe(1005);
  });

  it('grep returns empty matches for no hits without erroring', async () => {
    await writeFile(join(root, 'a.ts'), 'x\n');
    const result = await tools().grep!.execute({ pattern: 'definitely-not-present' }, {});
    expect(result.mode).toBe('content');
    expect(result.matches).toEqual([]);
  });

  it('grep excludes blocklisted dirs by default', async () => {
    await mkdir(join(root, 'node_modules/sub'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'node_modules/sub/a.ts'), 'hello\n');
    await writeFile(join(root, 'src/c.ts'), 'hello\n');
    const result = await tools().grep!.execute({ pattern: 'hello' }, {});
    expect(result.mode).toBe('content');
    const paths = result.matches.map((m: { file: string }) => m.file);
    expect(paths).toContain('./src/c.ts');
    expect(paths).not.toContain('./node_modules/sub/a.ts');
  });

  it('grep includes blocklisted dirs when no_blocklist is true', async () => {
    await mkdir(join(root, 'node_modules/sub'), { recursive: true });
    await writeFile(join(root, 'node_modules/sub/a.ts'), 'hello\n');
    const result = await tools().grep!.execute({ pattern: 'hello', no_blocklist: true }, {});
    expect(result.mode).toBe('content');
    const paths = result.matches.map((m: { file: string }) => m.file);
    expect(paths).toContain('./node_modules/sub/a.ts');
  });

  it('grep caps results at max_count and reports truncated', async () => {
    const lines = Array.from({ length: 50 }, () => 'match').join('\n');
    await writeFile(join(root, 'a.ts'), lines);
    const result = await tools().grep!.execute({ pattern: 'match', max_count: 10 }, {});
    expect(result.matches.length).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it('grep spills full results to output_file when truncated', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `match${i}`).join('\n');
    await writeFile(join(root, 'a.ts'), lines);
    const result = await tools().grep!.execute(
      { pattern: 'match', max_count: 10, output_file: 'spill.txt' },
      {},
    );
    expect(result.truncated).toBe(true);
    expect(result.spillFile).toBe('spill.txt');
    expect(result.matches.length).toBe(10);

    const spill = await executor.readFile('spill.txt');
    const spilled = spill.split('\n').filter((l) => l.length > 0);
    expect(spilled.length).toBe(25);
  });

  it('glob suppresses permission denied noise from tool result', async () => {
    await mkdir(join(root, 'locked'), { mode: 0o000 });
    await writeFile(join(root, 'a.ts'), 'x');
    const result = await tools().glob!.execute({ pattern: '**/*' }, {});
    const texts = result.files.join(' ');
    expect(texts).not.toContain('Permission denied');
    // ensure we did actually find the readable file
    expect(result.files).toContain('./a.ts');
  });

  it('grep suppresses permission denied noise from tool result', async () => {
    await mkdir(join(root, 'locked'), { mode: 0o000 });
    await writeFile(join(root, 'a.ts'), 'hello\n');
    const result = await tools().grep!.execute({ pattern: 'hello' }, {});
    const texts = result.matches.map((m: { text: string }) => m.text).join(' ');
    expect(texts).not.toContain('Permission denied');
    expect(result.matches.map((m: { file: string }) => m.file)).toContain('./a.ts');
  });
});
