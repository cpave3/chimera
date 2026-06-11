import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/context';
import {
  buildDiagnosticsRunner,
  detectDiagnosticsChecks,
  DiagnosticsRunner,
} from '../src/diagnostics';
import { buildEditTool } from '../src/edit';
import { LocalExecutor } from '../src/local-executor';
import { buildWriteTool } from '../src/write';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };
const asAny = (def: { tool: unknown }) => def.tool as AnyTool;

describe('DiagnosticsRunner', () => {
  let root: string;
  let executor: LocalExecutor;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-diag-'));
    executor = new LocalExecutor({ cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns null when the check passes', async () => {
    const runner = new DiagnosticsRunner({
      executor,
      checks: [{ name: 'ok-check', command: 'true', match: '\\.ts$' }],
    });
    expect(await runner.collect('src/foo.ts')).toBeNull();
  });

  it('returns the check output when it fails', async () => {
    const runner = new DiagnosticsRunner({
      executor,
      checks: [
        {
          name: 'failing-check',
          command: "echo 'src/foo.ts:3:1 error TS2322'; exit 1",
          match: '\\.ts$',
        },
      ],
    });
    const text = await runner.collect('src/foo.ts');
    expect(text).toContain('failing-check');
    expect(text).toContain('error TS2322');
  });

  it('skips checks whose pattern does not match the file', async () => {
    const runner = new DiagnosticsRunner({
      executor,
      checks: [{ name: 'ts-only', command: 'echo should-not-run; exit 1', match: '\\.ts$' }],
    });
    expect(await runner.collect('README.md')).toBeNull();
  });

  it('substitutes {file} into the command', async () => {
    const runner = new DiagnosticsRunner({
      executor,
      checks: [{ name: 'echo-file', command: 'echo checked {file}; exit 1', match: '\\.ts$' }],
    });
    const text = await runner.collect('src/foo.ts');
    expect(text).toContain('checked src/foo.ts');
  });

  it('clips oversized output', async () => {
    const runner = new DiagnosticsRunner({
      executor,
      checks: [{ name: 'noisy', command: 'yes error | head -c 100000; exit 1', match: '\\.ts$' }],
      maxOutputChars: 500,
    });
    const text = await runner.collect('src/foo.ts');
    expect(text!.length).toBeLessThan(700);
    expect(text).toContain('truncated');
  });

  it('swallows command spawn failures instead of blocking the edit', async () => {
    const runner = new DiagnosticsRunner({
      executor,
      checks: [{ name: 'missing', command: 'definitely-not-a-real-binary-xyz', match: '\\.ts$' }],
    });
    // Non-zero exit from a missing binary still surfaces as diagnostics text;
    // what must never happen is a thrown error.
    await expect(runner.collect('src/foo.ts')).resolves.toBeDefined();
  });
});

describe('edit/write tools — diagnostics feedback', () => {
  let root: string;
  let executor: LocalExecutor;
  let ctx: ToolContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-diagtool-'));
    executor = new LocalExecutor({ cwd: root });
    ctx = {
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
      diagnostics: new DiagnosticsRunner({
        executor,
        checks: [{ name: 'no-todo', command: '! grep -n TODO {file}', match: '\\.ts$' }],
      }),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('write returns diagnostics when the check fails', async () => {
    const write = asAny(buildWriteTool(ctx));
    const result = await write.execute({ path: 'foo.ts', content: 'const x = 1; // TODO\n' }, {});
    expect(result.diagnostics).toContain('no-todo');
    expect(result.diagnostics).toContain('TODO');
  });

  it('write omits diagnostics when the check passes', async () => {
    const write = asAny(buildWriteTool(ctx));
    const result = await write.execute({ path: 'foo.ts', content: 'const x = 1;\n' }, {});
    expect(result.diagnostics).toBeUndefined();
  });

  it('edit returns diagnostics when the check fails after the change', async () => {
    await executor.writeFile('foo.ts', 'const x = 1;\n');
    const edit = asAny(buildEditTool(ctx));
    const result = await edit.execute(
      { path: 'foo.ts', old_string: 'const x = 1;', new_string: 'const x = 2; // TODO' },
      {},
    );
    expect(result.replacements).toBe(1);
    expect(result.diagnostics).toContain('no-todo');
  });

  it('write skips diagnostics for non-matching files', async () => {
    const write = asAny(buildWriteTool(ctx));
    const result = await write.execute({ path: 'notes.md', content: 'TODO later\n' }, {});
    expect(result.diagnostics).toBeUndefined();
  });
});

describe('detectDiagnosticsChecks', () => {
  let root: string;
  let executor: LocalExecutor;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-detect-'));
    executor = new LocalExecutor({ cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns no checks in a bare directory', async () => {
    expect(await detectDiagnosticsChecks(root)).toEqual([]);
  });

  it('detects biome when config and local binary are present', async () => {
    await executor.writeFile('biome.json', '{}');
    await executor.writeFile('node_modules/@biomejs/biome/bin/biome', '');
    const checks = await detectDiagnosticsChecks(root);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe('biome');
    expect(checks[0]!.command).toContain('{file}');
  });

  it('skips biome when the binary is not installed', async () => {
    await executor.writeFile('biome.json', '{}');
    expect(await detectDiagnosticsChecks(root)).toEqual([]);
  });

  it('detects cerberus from .cerberus/config.yaml', async () => {
    await executor.writeFile('.cerberus/config.yaml', 'version: 1\n');
    const checks = await detectDiagnosticsChecks(root);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe('cerberus');
    expect(checks[0]!.command).toContain('cerberus run quick');
  });
});

describe('buildDiagnosticsRunner', () => {
  let root: string;
  let executor: LocalExecutor;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-diagcfg-'));
    executor = new LocalExecutor({ cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns undefined when disabled', async () => {
    await executor.writeFile('.cerberus/config.yaml', 'version: 1\n');
    const runner = await buildDiagnosticsRunner({
      cwd: root,
      executor,
      config: { enabled: false },
    });
    expect(runner).toBeUndefined();
  });

  it('returns undefined when nothing is detected or configured', async () => {
    expect(await buildDiagnosticsRunner({ cwd: root, executor })).toBeUndefined();
  });

  it('explicit checks override detected checks of the same name', async () => {
    await executor.writeFile('.cerberus/config.yaml', 'version: 1\n');
    const runner = await buildDiagnosticsRunner({
      cwd: root,
      executor,
      config: {
        checks: [{ name: 'cerberus', command: 'echo custom-cerberus; exit 1', match: '\\.ts$' }],
      },
    });
    const text = await runner!.collect('src/foo.ts');
    expect(text).toContain('custom-cerberus');
    expect(text).not.toContain('run quick');
  });

  it('autoDetect false skips detection but keeps explicit checks', async () => {
    await executor.writeFile('.cerberus/config.yaml', 'version: 1\n');
    const runner = await buildDiagnosticsRunner({
      cwd: root,
      executor,
      config: {
        autoDetect: false,
        checks: [{ name: 'custom', command: 'true', match: '\\.ts$' }],
      },
    });
    expect(runner!.hasChecks()).toBe(true);
    expect(await runner!.collect('src/foo.ts')).toBeNull();
  });
});
