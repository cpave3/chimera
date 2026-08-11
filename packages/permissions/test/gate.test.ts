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

  it('mandatory bash policy findings override auto-approve all', async () => {
    let raisedRequest: PermissionRequest | undefined;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'all',
      commandPolicy: {
        evaluator: {
          async evaluate() {
            return {
              version: 1,
              outcome: 'approval_required',
              stages: [
                {
                  id: 'risk',
                  status: 'findings',
                  findings: [
                    {
                      kind: 'risk',
                      stageId: 'risk',
                      level: 'critical',
                      score: 100,
                      message: 'critical command',
                    },
                  ],
                },
              ],
              findings: [
                {
                  kind: 'risk',
                  stageId: 'risk',
                  level: 'critical',
                  score: 100,
                  message: 'critical command',
                },
              ],
            };
          },
        },
        context: (request) => ({
          command: request.command,
          target: 'host',
          cwd: request.cwd,
          home: '/home/user',
          projectRoot: request.cwd,
          roots: { read: [request.cwd], write: [request.cwd] },
        }),
      },
      raiseRequest: async (request) => {
        raisedRequest = request;
        return { decision: 'deny', remembered: false };
      },
    });

    const resolution = await gate.request(req({ command: 'rm -rf /' }));

    expect(resolution.decision).toBe('deny');
    expect(raisedRequest?.policyAnalysis?.findings[0]).toMatchObject({
      kind: 'risk',
      level: 'critical',
    });
  });

  it('requires sudo authentication after approval despite matching allow rules', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'all',
      commandPolicy: {
        evaluator: {
          async evaluate() {
            return {
              version: 1,
              outcome: 'approval_required',
              stages: [],
              findings: [
                {
                  kind: 'elevation',
                  stageId: 'sudo_approval',
                  ruleId: 'sudo',
                  message: 'sudo requires approval',
                },
              ],
            };
          },
        },
        context: (request) => ({
          command: request.command,
          target: 'host',
          cwd: request.cwd,
          home: '/home/user',
          projectRoot: request.cwd,
          roots: { read: [request.cwd], write: [request.cwd] },
        }),
      },
      raiseRequest: async () => ({ decision: 'allow', remembered: false }),
    });
    gate.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'sudo true',
        patternKind: 'exact',
        decision: 'allow',
        createdAt: Date.now(),
      },
      'session',
    );

    await expect(gate.request(req({ command: 'sudo true' }))).resolves.toMatchObject({
      decision: 'allow',
      remembered: false,
      authentication: 'sudo',
    });
  });

  it('keeps explicit deny rules effective for mandatory findings', async () => {
    let raised = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'all',
      commandPolicy: {
        evaluator: {
          async evaluate() {
            return {
              version: 1,
              outcome: 'approval_required',
              stages: [],
              findings: [
                {
                  kind: 'risk',
                  stageId: 'risk',
                  level: 'danger',
                  message: 'dangerous command',
                },
              ],
            };
          },
        },
        context: (request) => ({
          command: request.command,
          target: 'host',
          cwd: request.cwd,
          home: '/home/user',
          projectRoot: request.cwd,
          roots: { read: [request.cwd], write: [request.cwd] },
        }),
      },
      raiseRequest: async () => {
        raised++;
        return { decision: 'allow', remembered: false };
      },
    });
    gate.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'rm -rf /',
        patternKind: 'exact',
        decision: 'deny',
        createdAt: Date.now(),
      },
      'session',
    );

    await expect(gate.request(req({ command: 'rm -rf /' }))).resolves.toMatchObject({
      decision: 'deny',
    });
    expect(raised).toBe(0);
  });

  it('applies matching deny rules before safe-command auto-approval', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'host',
      raiseRequest: async () => ({ decision: 'allow', remembered: false }),
    });
    gate.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'echo safe',
        patternKind: 'exact',
        decision: 'deny',
        createdAt: Date.now(),
      },
      'session',
    );

    await expect(gate.request(req({ command: 'echo safe' }))).resolves.toMatchObject({
      decision: 'deny',
      denialSource: 'rule',
    });
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
    const resolution = await gate.request(req());
    expect(resolution.decision).toBe('allow');
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
    const resolution = await gate.request(req({ command: 'pnpm i' }));
    expect(receivedCommand).toBe('pnpm i');
    expect(resolution.decision).toBe('deny');
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
    const resolution = await gate.request(req({ command: 'pnpm test' }));
    expect(resolution.decision).toBe('allow');
    expect(resolution.remembered).toBe(true);
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
    const resolution = await gate.request(req({ target: 'host', command: 'rm -rf /' }));
    expect(resolution.decision).toBe('deny');
    expect(resolution.remembered).toBe(false);
    expect(resolution.denialSource).toBe('headless');
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
    const resolution = await gate.request(req({ command: 'pnpm test' }));
    expect(resolution.decision).toBe('allow');
  });
});
