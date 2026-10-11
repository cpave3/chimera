import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandPolicyFinding,
  PermissionDecisionSource,
  PermissionRequest,
  PermissionResolution,
} from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultPermissionGate, type GateOptions } from '../src/gate';

const pathFinding: CommandPolicyFinding = {
  kind: 'path',
  stageId: 'path_authorization',
  operation: 'write',
  path: '/home/u/.cache/tool',
  requiredGrant: 'write',
  message: 'write outside the authorized directories',
};
const riskFinding: CommandPolicyFinding = {
  kind: 'risk',
  stageId: 'risk',
  level: 'danger',
  score: 70,
  message: 'dangerous command',
};
const sudoFinding: CommandPolicyFinding = {
  kind: 'elevation',
  stageId: 'sudo_approval',
  ruleId: 'sudo',
  message: 'sudo needs approval',
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'chimera-gate-sandbox-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function request(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return { requestId: 'r1', tool: 'bash', target: 'host', command: 'make cache', cwd, ...over };
}

/** A gate whose policy reports the given findings and whose user answers as told. */
function gate(findings: CommandPolicyFinding[], over: Partial<GateOptions> = {}) {
  const asked: PermissionRequest[] = [];
  const audited: Array<{
    source: PermissionDecisionSource;
    decision: string;
    request: PermissionRequest;
  }> = [];
  const built = new DefaultPermissionGate({
    cwd,
    home: join(cwd, 'home'),
    autoApprove: 'host',
    commandPolicy: {
      evaluator: {
        async evaluate() {
          return {
            version: 1,
            outcome: findings.length === 0 ? 'pass' : 'approval_required',
            stages: [],
            findings,
          };
        },
      },
      context: (permissionRequest) => ({
        command: permissionRequest.command,
        target: 'host',
        cwd: permissionRequest.cwd,
        home: '/home/u',
        projectRoot: permissionRequest.cwd,
        roots: { read: [permissionRequest.cwd], write: [permissionRequest.cwd] },
      }),
    },
    raiseRequest: async (permissionRequest): Promise<PermissionResolution> => {
      asked.push(permissionRequest);
      return { decision: 'allow', remembered: false };
    },
    audit: ({ source, resolution, request: auditedRequest }) =>
      audited.push({ source, decision: resolution.decision, request: auditedRequest }),
    ...over,
  });
  return { gate: built, asked, audited };
}

describe('path findings and the OS sandbox', () => {
  it('ask the user when the command runs without the sandbox', async () => {
    const { gate: built, asked } = gate([pathFinding]);

    await built.request(request());

    expect(asked).toHaveLength(1);
  });

  it('do not ask when the command runs in the sandbox: the kernel refuses the write', async () => {
    const { gate: built, asked, audited } = gate([pathFinding]);

    const resolution = await built.request(request({ osSandbox: true }));

    expect(resolution.decision).toBe('allow');
    expect(asked).toEqual([]);
    expect(audited).toMatchObject([{ source: 'automatic', decision: 'allow' }]);
  });

  it('leave a risk finding in force in the sandbox', async () => {
    const { gate: built, asked } = gate([pathFinding, riskFinding]);

    await built.request(request({ osSandbox: true }));

    expect(asked).toHaveLength(1);
    // The user is shown what still matters, not what the sandbox takes care of.
    expect(asked[0]!.policyAnalysis?.findings).toEqual([riskFinding]);
  });

  it('leave a sudo finding in force in the sandbox, with its authentication', async () => {
    const { gate: built, asked } = gate([sudoFinding]);

    const resolution = await built.request(
      request({ osSandbox: true, command: 'sudo make install' }),
    );

    expect(asked).toHaveLength(1);
    expect(resolution).toMatchObject({ decision: 'allow', authentication: 'sudo' });
  });
});

describe('a request to run outside the OS sandbox', () => {
  const unsandboxed = request({
    unsandboxed: true,
    reason: 'pnpm writes its store in the home directory',
  });

  it('asks the user even when auto-approval and an allow rule would admit the command', async () => {
    const { gate: built, asked } = gate([], { autoApprove: 'all' });
    built.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'make cache',
        patternKind: 'exact',
        decision: 'allow',
        createdAt: 1,
      },
      'session',
    );

    const resolution = await built.request(unsandboxed);

    expect(resolution.decision).toBe('allow');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.reason).toBe('pnpm writes its store in the home directory');
    expect(asked[0]!.policyAnalysis?.findings).toContainEqual({
      kind: 'elevation',
      stageId: 'os_sandbox',
      ruleId: 'unsandboxed',
      message: 'Runs outside the OS sandbox: pnpm writes its store in the home directory',
    });
  });

  it('asks the user also when the command policy is turned off', async () => {
    const { gate: built, asked } = gate([], { autoApprove: 'all', commandPolicy: undefined });

    await built.request(unsandboxed);

    expect(asked).toHaveLength(1);
  });

  it('is denied where nobody can answer', async () => {
    const { gate: built, asked } = gate([], { headlessAutoDeny: true });

    const resolution = await built.request(unsandboxed);

    expect(resolution).toMatchObject({ decision: 'deny', denialSource: 'headless' });
    expect(asked).toEqual([]);
  });

  it('is denied by a matching deny rule without a prompt', async () => {
    const { gate: built, asked } = gate([]);
    built.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'make cache',
        patternKind: 'exact',
        decision: 'deny',
        createdAt: 1,
      },
      'session',
    );

    const resolution = await built.request(unsandboxed);

    expect(resolution).toMatchObject({ decision: 'deny', denialSource: 'rule' });
    expect(asked).toEqual([]);
  });

  it('goes to the audit log as a decision of the user', async () => {
    const { gate: built, audited } = gate([]);

    await built.request(unsandboxed);

    expect(audited).toMatchObject([
      { source: 'user', decision: 'allow', request: { unsandboxed: true } },
    ]);
  });

  it('keeps the findings the policy has on the command as well', async () => {
    const { gate: built, asked } = gate([riskFinding]);

    await built.request(unsandboxed);

    expect(asked[0]!.policyAnalysis?.findings.map((finding) => finding.kind)).toEqual([
      'risk',
      'elevation',
    ]);
  });
});
