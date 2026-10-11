import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { interceptTools } from '../src/intercept';
import { nestedInstructions } from '../src/nested-instructions';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'chimera-nested-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function file(path: string, content: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
}

/** File tools that succeed with a small object, behind the interceptor. */
function tools(over: Record<string, (args: unknown) => unknown> = {}) {
  const definitions: Record<string, { execute: (args: unknown) => Promise<unknown> }> = {};
  for (const name of ['read', 'edit', 'write', 'apply_patch', 'grep']) {
    definitions[name] = { execute: async (args) => (over[name] ?? (() => ({ ok: true })))(args) };
  }
  const wrapped = interceptTools(definitions as unknown as ToolSet, [nestedInstructions({ cwd })]);
  return (name: string, args: unknown) =>
    (
      wrapped[name] as unknown as { execute: (args: unknown, options: unknown) => Promise<unknown> }
    ).execute(args, {});
}

describe('nested instruction files', () => {
  it('come with the first file tool call in their directory', async () => {
    file('packages/api/AGENTS.md', 'Use the query builder.');
    file('packages/api/src/server.ts', '');
    const call = tools();

    const result = await call('read', { path: 'packages/api/src/server.ts' });

    expect(result).toEqual({
      ok: true,
      instructions: [{ path: 'packages/api/AGENTS.md', content: 'Use the query builder.' }],
    });
  });

  it('are sent once in a session', async () => {
    file('packages/api/AGENTS.md', 'Use the query builder.');
    const call = tools();
    await call('read', { path: 'packages/api/src/server.ts' });

    expect(await call('read', { path: 'packages/api/src/routes.ts' })).toEqual({ ok: true });
    expect(await call('edit', { path: 'packages/api/src/server.ts' })).toEqual({ ok: true });
  });

  it('come outermost first when several levels have one', async () => {
    file('packages/AGENTS.md', 'All packages: strict types.');
    file('packages/api/src/db/CLAUDE.md', 'No raw SQL.');
    const call = tools();

    const result = (await call('edit', { path: 'packages/api/src/db/query.ts' })) as {
      instructions: Array<{ path: string }>;
    };

    expect(result.instructions.map((entry) => entry.path)).toEqual([
      'packages/AGENTS.md',
      'packages/api/src/db/CLAUDE.md',
    ]);
  });

  it('prefer AGENTS.md over CLAUDE.md, and add the local override after it', async () => {
    file('pkg/AGENTS.md', 'shared');
    file('pkg/CLAUDE.md', 'ignored');
    file('pkg/AGENTS.local.md', 'mine');
    const call = tools();

    const result = (await call('write', { path: 'pkg/new.ts' })) as {
      instructions: Array<{ path: string; content: string }>;
    };

    expect(result.instructions).toEqual([
      { path: 'pkg/AGENTS.md', content: 'shared' },
      { path: 'pkg/AGENTS.local.md', content: 'mine' },
    ]);
  });

  it('leave out the working directory itself, whose files are in the system prompt', async () => {
    file('AGENTS.md', 'root rules');
    const call = tools();

    expect(await call('read', { path: 'README.md' })).toEqual({ ok: true });
    expect(await call('read', { path: join(cwd, 'src/index.ts') })).toEqual({ ok: true });
  });

  it('ignore files outside the working directory', async () => {
    const call = tools();
    expect(await call('read', { path: '/tmp/elsewhere/file.ts' })).toEqual({ ok: true });
    expect(await call('read', { path: '../sibling/file.ts' })).toEqual({ ok: true });
  });

  it('wait for a call that succeeds', async () => {
    file('pkg/AGENTS.md', 'rules');
    let fail = true;
    const call = tools({
      read: () => {
        if (fail) throw new Error('no such file');
        return { ok: true };
      },
    });

    await expect(call('read', { path: 'pkg/missing.ts' })).rejects.toThrow('no such file');
    fail = false;

    expect(await call('read', { path: 'pkg/there.ts' })).toMatchObject({
      instructions: [{ path: 'pkg/AGENTS.md' }],
    });
  });

  it('follow every file a patch touches', async () => {
    file('a/AGENTS.md', 'rules for a');
    file('b/AGENTS.md', 'rules for b');
    const call = tools();
    const patch = [
      '*** Begin Patch',
      '*** Update File: a/one.ts',
      '@@',
      '-old',
      '+new',
      '*** Add File: b/two.ts',
      '+hello',
      '*** End Patch',
    ].join('\n');

    const result = (await call('apply_patch', { input: patch })) as {
      instructions: Array<{ path: string }>;
    };

    expect(result.instructions.map((entry) => entry.path)).toEqual(['a/AGENTS.md', 'b/AGENTS.md']);
  });

  it('leave other tools alone', async () => {
    file('pkg/AGENTS.md', 'rules');
    const call = tools();
    expect(await call('grep', { pattern: 'x', path: 'pkg' })).toEqual({ ok: true });
  });

  it('cut a large instruction file to the size limit', async () => {
    file('pkg/AGENTS.md', `${'y'.repeat(63)}\n`.repeat(50 * 16));
    const call = tools();

    const result = (await call('read', { path: 'pkg/x.ts' })) as {
      instructions: Array<{ content: string }>;
    };

    expect(result.instructions[0]!.content).toMatch(/This file was cut/);
    expect(Buffer.byteLength(result.instructions[0]!.content)).toBeLessThan(33 * 1024);
  });
});
