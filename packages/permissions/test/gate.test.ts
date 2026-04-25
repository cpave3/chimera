import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRequest, PermissionResolution } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultPermissionGate } from '../src/gate';

function req(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'r1',
    tool: 'bash',
    target: 'host',
    command: 'pnpm test',
    cwd: '/tmp',
    ...overrides,
  };
}

describe('DefaultPermissionGate', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-gate-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('auto-approves host calls at level=host', async () => {
    let raised = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'host',
      raiseRequest: async (): Promise<PermissionResolution> => {
        raised += 1;
        return { decision: 'allow', remembered: false };
      },
    });
    const res = await gate.request(req());
    expect(res.decision).toBe('allow');
    expect(raised).toBe(0);
  });

  it('raises a request at level=none when no rule matches', async () => {
    let receivedCommand = '';
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async (r) => {
        receivedCommand = r.command;
        return { decision: 'deny', remembered: false };
      },
    });
    const res = await gate.request(req({ command: 'pnpm i' }));
    expect(receivedCommand).toBe('pnpm i');
    expect(res.decision).toBe('deny');
  });

  it('matching allow rule bypasses prompt', async () => {
    let raised = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => {
        raised += 1;
        return { decision: 'deny', remembered: false };
      },
    });
    gate.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'pnpm test',
        patternKind: 'exact',
        decision: 'allow',
        createdAt: Date.now(),
      },
      'project',
    );
    const res = await gate.request(req({ command: 'pnpm test' }));
    expect(res.decision).toBe('allow');
    expect(res.remembered).toBe(true);
    expect(raised).toBe(0);
  });

  it('applyRemember with project scope persists a glob rule', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => ({ decision: 'allow', remembered: false }),
    });
    gate.applyRemember(
      { scope: 'project', pattern: 'git push *', patternKind: 'glob' },
      req({ command: 'git push origin main' }),
      'allow',
    );
    const rules = gate.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.pattern).toBe('git push *');
  });

  it('headlessAutoDeny denies host-target requests without raising', async () => {
    let raised = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      headlessAutoDeny: true,
      raiseRequest: async () => {
        raised += 1;
        return { decision: 'allow', remembered: false };
      },
    });
    const res = await gate.request(req({ target: 'host', command: 'rm -rf /' }));
    expect(res.decision).toBe('deny');
    expect(res.remembered).toBe(false);
    expect(raised).toBe(0);
  });

  it('headlessAutoDeny respects existing allow rules instead of denying', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      headlessAutoDeny: true,
      raiseRequest: async () => ({ decision: 'deny', remembered: false }),
    });
    gate.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'pnpm test',
        patternKind: 'exact',
        decision: 'allow',
        createdAt: Date.now(),
      },
      'project',
    );
    const res = await gate.request(req({ command: 'pnpm test' }));
    expect(res.decision).toBe('allow');
  });
});
