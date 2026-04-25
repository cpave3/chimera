import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionGate, PermissionRequest, PermissionResolution } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBashTool } from '../src/bash';
import { LocalExecutor } from '../src/local-executor';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };

const asAny = (def: ReturnType<typeof buildBashTool>) =>
  def.tool as unknown as AnyTool;

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

describe('bash tool — sandbox vs host routing', () => {
  let root: string;
  let sandboxExecutor: LocalExecutor;
  let hostExecutor: LocalExecutor;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-route-'));
    sandboxExecutor = new LocalExecutor({ cwd: root });
    hostExecutor = new LocalExecutor({ cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('sandbox-target call bypasses the gate when sandbox is on', async () => {
    const gate = new FakeGate();
    const tool = asAny(buildBashTool({
      sandboxExecutor,
      hostExecutor,
      sandboxMode: 'overlay',
      permissionGate: gate,
    }));
    const r = await tool.execute({ command: 'echo sandboxed', target: 'sandbox' }, {});
    expect(r.exit_code).toBe(0);
    expect(gate.request).not.toHaveBeenCalled();
  });

  it('host-target call invokes the gate when sandbox is on (with reason)', async () => {
    const gate = new FakeGate();
    const tool = asAny(buildBashTool({
      sandboxExecutor,
      hostExecutor,
      sandboxMode: 'overlay',
      permissionGate: gate,
    }));
    const r = await tool.execute(
      { command: 'echo on host', target: 'host', reason: 'need real env' },
      {},
    );
    expect(r.exit_code).toBe(0);
    expect(gate.request).toHaveBeenCalledOnce();
    expect(gate.request.mock.calls[0]![0].target).toBe('host');
  });

  it('host-target without reason is refused before reaching the gate', async () => {
    const gate = new FakeGate();
    const tool = asAny(buildBashTool({
      sandboxExecutor,
      hostExecutor,
      sandboxMode: 'overlay',
      permissionGate: gate,
    }));
    const r = await tool.execute({ command: 'rm -rf /tmp/foo', target: 'host' }, {});
    expect(r.exit_code).toBe(-1);
    expect(r.stderr).toMatch(/requires a 'reason'/);
    expect(gate.request).not.toHaveBeenCalled();
  });

  it('default target is host when sandbox is off', async () => {
    const gate = new FakeGate();
    const tool = asAny(buildBashTool({
      sandboxExecutor,
      hostExecutor,
      sandboxMode: 'off',
      permissionGate: gate,
    }));
    const r = await tool.execute({ command: 'echo hi' }, {});
    expect(r.exit_code).toBe(0);
    // Sandbox-off path doesn't gate either; tool short-circuits to the
    // executor without consulting the gate.
    expect(gate.request).not.toHaveBeenCalled();
  });
});
