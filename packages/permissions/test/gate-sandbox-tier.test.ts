import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRequest, PermissionResolution } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultPermissionGate } from '../src/gate';

function hostReq(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'r1',
    tool: 'bash',
    target: 'host',
    command: 'rm -rf /home',
    cwd: '/tmp',
    ...overrides,
  };
}

/**
 * Spec §8.1 — `--auto-approve sandbox` must:
 *   (a) auto-approve sandbox-target tool calls; and
 *   (b) prompt the user on host-target calls.
 *
 * Sandbox-target calls never reach the gate (the bash tool short-circuits
 * to `ctx.sandboxExecutor` directly when sandbox is on). This test
 * documents the second half: at level `sandbox`, host-target calls fall
 * through to `raiseRequest`.
 */
describe('DefaultPermissionGate — sandbox tier', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-gate-sb-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('host-target calls still prompt at level=sandbox', async () => {
    let raised = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'sandbox',
      raiseRequest: async (): Promise<PermissionResolution> => {
        raised += 1;
        return { decision: 'allow', remembered: false };
      },
    });
    const res = await gate.request(hostReq());
    expect(res.decision).toBe('allow');
    expect(raised).toBe(1);
  });

  it('host-target calls still prompt at level=none', async () => {
    let raised = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async (): Promise<PermissionResolution> => {
        raised += 1;
        return { decision: 'deny', remembered: false };
      },
    });
    await gate.request(hostReq());
    expect(raised).toBe(1);
  });
});
