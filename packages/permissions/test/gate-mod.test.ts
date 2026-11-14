import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRequest } from '@chimera/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DefaultPermissionGate } from '../src/gate';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'chimera-gate-mod-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function request(): PermissionRequest {
  return { requestId: 'mod-request', tool: 'bash', target: 'host', command: 'echo mod', cwd };
}

it('lets a mod allow before shell hooks, System One, reviewer, and operator, with audit and resolution', async () => {
  const interceptPermission = vi.fn(async () => 'allow' as const);
  const permissionRequest = vi.fn(async () => ({ blocked: true }));
  const systemCheck = vi.fn(async () => ({
    decision: 'allow' as const,
    note: 'safe',
    threshold: 0.8,
  }));
  const review = vi.fn();
  const raiseRequest = vi.fn();
  const audit = vi.fn();
  const emitResolved = vi.fn();
  const gate = new DefaultPermissionGate({
    cwd,
    home: cwd,
    autoApprove: 'none',
    interceptPermission,
    permissionRequest,
    systemOne: { check: systemCheck },
    reviewer: { review },
    raiseRequest,
    audit,
    emitResolved,
  });
  await expect(gate.request(request())).resolves.toEqual({ decision: 'allow', remembered: false });
  expect(interceptPermission).toHaveBeenCalledWith(request(), undefined);
  expect(permissionRequest).not.toHaveBeenCalled();
  expect(systemCheck).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
  expect(raiseRequest).not.toHaveBeenCalled();
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ source: 'mod' }));
  expect(emitResolved).toHaveBeenCalledWith('mod-request', 'allow', false);
});

it('preserves a mod denial message, including for MCP with original arguments', async () => {
  const args = { token: 'private', query: 'hello' };
  const interceptPermission = vi.fn(async () => ({
    decision: 'deny' as const,
    message: 'frozen by mod',
  }));
  const raiseRequest = vi.fn();
  const audit = vi.fn();
  const gate = new DefaultPermissionGate({
    cwd,
    home: cwd,
    autoApprove: 'all',
    interceptPermission,
    raiseRequest,
    audit,
  });
  await expect(
    gate.requestMcp({ requestId: 'mcp', server: 'test', tool: 'write', args, cwd }),
  ).resolves.toEqual({
    decision: 'deny',
    denialSource: 'mod',
    feedback: 'frozen by mod',
    remembered: false,
  });
  expect(interceptPermission).toHaveBeenCalledWith(
    expect.objectContaining({
      tool: 'mcp',
      mcp: expect.objectContaining({ server: 'test', tool: 'write' }),
    }),
    args,
  );
  expect(raiseRequest).not.toHaveBeenCalled();
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ source: 'mod' }));
});

it.each([
  'pass',
  { decision: 'pass' },
] as const)('continues to the normal prompt on %j', async (result) => {
  const order: string[] = [];
  const gate = new DefaultPermissionGate({
    cwd,
    home: cwd,
    autoApprove: 'none',
    interceptPermission: async () => {
      order.push('mod');
      return result;
    },
    permissionRequest: async () => {
      order.push('hook');
      return { blocked: false };
    },
    raiseRequest: async () => {
      order.push('operator');
      return { decision: 'deny', remembered: false };
    },
  });
  await expect(gate.request(request())).resolves.toMatchObject({
    decision: 'deny',
    denialSource: 'user',
  });
  expect(order).toEqual(['mod', 'hook', 'operator']);
});

it.each([
  'allow',
  'deny',
] as const)('does not intercept a matching %s rule, including MCP', async (decision) => {
  const interceptPermission = vi.fn(async () => 'allow' as const);
  const gate = new DefaultPermissionGate({
    cwd,
    home: cwd,
    autoApprove: 'none',
    interceptPermission,
    raiseRequest: vi.fn(),
  });
  for (const tool of ['bash', 'mcp'] as const) {
    gate.addRule(
      {
        tool,
        target: 'host',
        pattern: tool === 'bash' ? 'echo mod' : 'test/write',
        patternKind: 'exact',
        decision,
        createdAt: Date.now(),
      },
      'session',
    );
  }
  expect((await gate.request(request())).decision).toBe(decision);
  expect(
    (await gate.requestMcp({ requestId: 'mcp', server: 'test', tool: 'write', args: {}, cwd }))
      .decision,
  ).toBe(decision);
  expect(interceptPermission).not.toHaveBeenCalled();
});

it('does not intercept automatic approvals or trusted MCP tools', async () => {
  const interceptPermission = vi.fn(async () => 'deny' as const);
  const gate = new DefaultPermissionGate({
    cwd,
    home: cwd,
    autoApprove: 'all',
    interceptPermission,
    raiseRequest: vi.fn(),
  });
  expect((await gate.request(request())).decision).toBe('allow');
  expect(
    (
      await gate.requestMcp({ requestId: 'mcp', server: 'test', tool: 'read', args: {}, cwd }, [
        'read',
      ])
    ).decision,
  ).toBe('allow');
  expect(interceptPermission).not.toHaveBeenCalled();
});

it('does not let a mod override a blocked command policy', async () => {
  const interceptPermission = vi.fn(async () => 'allow' as const);
  const gate = new DefaultPermissionGate({
    cwd,
    home: cwd,
    autoApprove: 'all',
    interceptPermission,
    raiseRequest: vi.fn(),
    commandPolicy: {
      context: () => ({
        command: 'echo mod',
        target: 'host',
        cwd,
        home: cwd,
        projectRoot: cwd,
        roots: { read: [cwd], write: [cwd] },
      }),
      evaluator: {
        evaluate: async () => ({
          version: 1,
          outcome: 'approval_required',
          stages: [],
          findings: [{ kind: 'blocked', stageId: 'test', ruleId: 'blocked', message: 'never' }],
        }),
      },
    },
  });
  await expect(gate.request(request())).resolves.toMatchObject({
    decision: 'deny',
    denialSource: 'policy',
  });
  expect(interceptPermission).not.toHaveBeenCalled();
});
