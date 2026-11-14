import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultHookRunner, type HookRunner } from '@chimera/hooks';
import { interceptTools } from '@chimera/tools';
import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preToolUseHook } from '../src/pre-tool-use';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'chimera-pre-tool-use-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function hook(body: string): Promise<void> {
  const directory = join(root, 'project', 'PreToolUse');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'guard.sh'), body);
  await chmod(join(directory, 'guard.sh'), 0o755);
}

function runner(timeoutMs = 5_000): HookRunner {
  return new DefaultHookRunner({
    cwd: root,
    sessionId: '01J0HK0EJ0AAAAAAAAAAAAAAAA',
    globalRoot: join(root, 'global'),
    projectRoot: join(root, 'project'),
    timeoutMs,
    log: () => {},
  });
}

/** A `write` tool behind the hook that records what reached it. */
function guarded(hookRunner: HookRunner) {
  const ran: unknown[] = [];
  const tools = interceptTools(
    {
      write: {
        execute: async (args: unknown) => {
          ran.push(args);
          return { ok: true };
        },
      },
    } as unknown as ToolSet,
    [preToolUseHook(({ type, ...payload }) => hookRunner.fire({ event: type, ...payload }))],
  );
  const call = (args: unknown) =>
    (
      tools.write as unknown as { execute: (args: unknown, options: object) => Promise<unknown> }
    ).execute(args, {});
  return { call, ran };
}

describe('PreToolUse hook around a tool call', () => {
  it('lets the call run when the hook allows it', async () => {
    await hook('#!/bin/sh\nexit 0\n');
    const { call, ran } = guarded(runner());

    expect(await call({ path: 'a.ts', content: 'x' })).toEqual({ ok: true });
    expect(ran).toEqual([{ path: 'a.ts', content: 'x' }]);
  });

  it('runs the call with no hook installed', async () => {
    const { call, ran } = guarded(runner());

    expect(await call({ path: 'a.ts' })).toEqual({ ok: true });
    expect(ran).toHaveLength(1);
  });

  it('answers a blocked call with the reason, and does not run the tool', async () => {
    await hook('#!/bin/sh\necho "no writes to migrations/" >&2\nexit 2\n');
    const { call, ran } = guarded(runner());

    await expect(call({ path: 'migrations/1.sql' })).rejects.toThrow(
      'blocked by PreToolUse hook: no writes to migrations/',
    );
    expect(ran).toEqual([]);
  });

  it('blocks on a JSON decision too', async () => {
    await hook(`#!/bin/sh\necho '{"decision":"block","reason":"frozen"}'\n`);
    const { call, ran } = guarded(runner());

    await expect(call({ path: 'a.ts' })).rejects.toThrow('blocked by PreToolUse hook: frozen');
    expect(ran).toEqual([]);
  });

  it('decides on the input: the same hook allows one call and blocks another', async () => {
    await hook(
      '#!/bin/sh\npayload=$(cat)\ncase "$payload" in *migrations/*) echo "frozen" >&2; exit 2;; esac\nexit 0\n',
    );
    const { call, ran } = guarded(runner());

    await call({ path: 'src/a.ts' });
    await expect(call({ path: 'migrations/1.sql' })).rejects.toThrow('frozen');
    expect(ran).toEqual([{ path: 'src/a.ts' }]);
  });

  it('runs the call when the hook runs out of time', async () => {
    await hook('#!/bin/sh\nsleep 5\nexit 2\n');
    const { call, ran } = guarded(runner(200));

    expect(await call({ path: 'a.ts' })).toEqual({ ok: true });
    expect(ran).toHaveLength(1);
  });
});
