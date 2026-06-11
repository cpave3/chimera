import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionGate, PermissionRequest, PermissionResolution } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundProcessManager } from '../src/background';
import { buildBashKillTool, buildBashOutputTool } from '../src/background-tools';
import { buildBashTool } from '../src/bash';
import type { ToolContext } from '../src/context';
import { LocalExecutor } from '../src/local-executor';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };

const asAny = (def: { tool: unknown }) => def.tool as AnyTool;

class FakeGate implements PermissionGate {
  request = vi.fn(
    async (_req: PermissionRequest): Promise<PermissionResolution> => ({
      decision: 'allow',
      remembered: false,
    }),
  );
  check = vi.fn(() => null);
  addRule = vi.fn();
  listRules = vi.fn(() => []);
  removeRule = vi.fn();
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('bash tool — run_in_background', () => {
  let root: string;
  let manager: BackgroundProcessManager;
  let gate: FakeGate;
  let ctx: ToolContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-bgtool-'));
    manager = new BackgroundProcessManager({ cwd: root });
    gate = new FakeGate();
    const executor = new LocalExecutor({ cwd: root });
    ctx = {
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
      permissionGate: gate,
      backgroundProcesses: manager,
    };
  });

  afterEach(async () => {
    manager.killAll();
    await rm(root, { recursive: true, force: true });
  });

  it('returns a shell id immediately and gates the launch', async () => {
    const bash = asAny(buildBashTool(ctx));
    const result = await bash.execute({ command: 'sleep 5', run_in_background: true }, {});
    expect(result.shell_id).toMatch(/^shell_\d+$/);
    expect(result.exit_code).toBeUndefined();
    expect(gate.request).toHaveBeenCalledOnce();
    expect(gate.request.mock.calls[0]![0].command).toBe('sleep 5');
    expect(manager.get(result.shell_id)?.status).toBe('running');
  });

  it('refuses background launch when the gate denies', async () => {
    gate.request.mockResolvedValueOnce({
      decision: 'deny',
      remembered: false,
      denialSource: 'user',
    });
    const bash = asAny(buildBashTool(ctx));
    const result = await bash.execute({ command: 'sleep 5', run_in_background: true }, {});
    expect(result.shell_id).toBeUndefined();
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/denied/);
  });

  it('refuses background launch for the sandbox target', async () => {
    const bash = asAny(buildBashTool({ ...ctx, sandboxMode: 'bind' }));
    const result = await bash.execute(
      { command: 'sleep 5', run_in_background: true, target: 'sandbox' },
      {},
    );
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/host/);
  });

  it('refuses background launch when no manager is registered', async () => {
    const bash = asAny(buildBashTool({ ...ctx, backgroundProcesses: undefined }));
    const result = await bash.execute({ command: 'sleep 5', run_in_background: true }, {});
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/not available/);
  });

  it('bash_output returns incremental output and final status', async () => {
    const bash = asAny(buildBashTool(ctx));
    const bashOutput = asAny(buildBashOutputTool(ctx));
    const launched = await bash.execute({ command: 'echo ready', run_in_background: true }, {});

    await until(() => manager.get(launched.shell_id)?.status === 'exited');
    const read = await bashOutput.execute({ shell_id: launched.shell_id }, {});
    expect(read.stdout).toContain('ready');
    expect(read.status).toBe('exited');
    expect(read.exit_code).toBe(0);

    const unknown = await bashOutput.execute({ shell_id: 'shell_999' }, {});
    expect(unknown.error).toMatch(/no background process/i);
  });

  it('bash_kill terminates a running background process', async () => {
    const bash = asAny(buildBashTool(ctx));
    const bashKill = asAny(buildBashKillTool(ctx));
    const launched = await bash.execute({ command: 'sleep 30', run_in_background: true }, {});

    const killed = await bashKill.execute({ shell_id: launched.shell_id }, {});
    expect(killed.killed).toBe(true);
    await until(() => manager.get(launched.shell_id)?.status === 'killed');

    const again = await bashKill.execute({ shell_id: launched.shell_id }, {});
    expect(again.killed).toBe(false);
  });
});
