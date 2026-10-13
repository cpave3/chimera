import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandPolicyFinding,
  PermissionDecisionSource,
  PermissionRequest,
  PermissionResolution,
} from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
            findings: [...findings],
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

describe('remembered sandbox bypass permissions', () => {
  it('admits an explicitly remembered exact command and audits the saved rule', async () => {
    const { gate: built, asked, audited } = gate([]);
    const bypass = request({ unsandboxed: true, reason: 'write host state' });
    built.applyRemember(
      { scope: 'session', pattern: bypass.command, patternKind: 'exact', allowUnsandboxed: true },
      bypass,
      'allow',
    );

    expect(await built.request(bypass)).toMatchObject({ decision: 'allow', remembered: true });
    expect(asked).toEqual([]);
    expect(audited).toMatchObject([{ source: 'rule', request: { unsandboxed: true } }]);
  });
});

it('remembers a safe command prefix for the session and admits another invocation', async () => {
  const { gate: built, asked } = gate([]);
  const bypass = request({ unsandboxed: true, command: 'legato plan submit .legato/plans/test' });
  built.applyRemember(
    { scope: 'session', pattern: 'legato plan', patternKind: 'prefix', allowUnsandboxed: true },
    bypass,
    'allow',
  );

  expect(await built.request({ ...bypass, command: 'legato plan status --json' })).toMatchObject({
    decision: 'allow',
    remembered: true,
  });
  expect(asked).toEqual([]);
});

it.each([
  'session',
  'project',
  'global',
] as const)('keeps an explicit exact bypass rule in its %s scope', async (scope) => {
  const { gate: built } = gate([], { headlessAutoDeny: true, autoApprove: 'none' });
  const bypass = request({ unsandboxed: true, command: 'legato plan status' });
  built.applyRemember(
    { scope, pattern: bypass.command, patternKind: 'exact', allowUnsandboxed: true },
    bypass,
    'allow',
  );
  expect(await built.request(bypass)).toMatchObject({ decision: 'allow', remembered: true });
  const { gate: reloaded } = gate([], { headlessAutoDeny: true, autoApprove: 'none' });
  expect(await reloaded.request(bypass)).toMatchObject(
    scope === 'session'
      ? { decision: 'deny', denialSource: 'headless' }
      : { decision: 'allow', remembered: true },
  );
  expect(await built.request({ ...bypass, command: 'legato plan submit' })).toMatchObject({
    decision: 'deny',
    denialSource: 'headless',
  });
  expect(await built.request({ ...bypass, unsandboxed: false })).toMatchObject({
    decision: 'deny',
    denialSource: 'headless',
  });
});

it.each([
  riskFinding,
  pathFinding,
  sudoFinding,
])('keeps other mandatory findings in force: $kind/$stageId', async (finding) => {
  const { gate: built, asked } = gate([finding]);
  const bypass = request({ unsandboxed: true });
  built.applyRemember(
    { scope: 'session', pattern: bypass.command, patternKind: 'exact', allowUnsandboxed: true },
    bypass,
    'allow',
  );
  const resolution = await built.request(bypass);
  expect(asked).toHaveLength(1);
  expect(resolution.remembered).toBe(false);
  if (finding === sudoFinding) expect(resolution.authentication).toBe('sudo');
});

it.each([
  'project',
  'global',
] as const)('keeps a %s prefix bypass in its storage scope across projects', async (scope) => {
  const bypass = request({ unsandboxed: true, command: 'legato plan status' });
  const { gate: built } = gate([]);
  built.applyRemember(
    { scope, pattern: 'legato plan', patternKind: 'prefix', allowUnsandboxed: true },
    bypass,
    'allow',
  );
  const { gate: otherProject } = gate([], {
    cwd: join(cwd, 'other-project'),
    autoApprove: 'none',
    headlessAutoDeny: true,
  });
  expect(
    await otherProject.request({ ...bypass, command: 'legato plan submit /tmp/plan' }),
  ).toMatchObject(
    scope === 'global'
      ? { decision: 'allow', remembered: true }
      : { decision: 'deny', denialSource: 'headless' },
  );
});

it('a saved bypass allow never overrides a matching deny rule', async () => {
  const { gate: built, asked } = gate([]);
  const bypass = request({ unsandboxed: true });
  built.applyRemember(
    { scope: 'session', pattern: bypass.command, patternKind: 'exact', allowUnsandboxed: true },
    bypass,
    'allow',
  );
  built.applyRemember(
    { scope: 'session', pattern: bypass.command, patternKind: 'exact' },
    bypass,
    'deny',
  );
  expect(await built.request(bypass)).toMatchObject({ decision: 'deny', denialSource: 'rule' });
  expect(asked).toEqual([]);
});

it('a saved bypass allow never overrides a blocked finding', async () => {
  const { gate: built, asked } = gate([
    {
      kind: 'blocked',
      stageId: 'hard_blocks',
      ruleId: 'blocked',
      message: 'blocked command',
    },
  ]);
  const bypass = request({ unsandboxed: true });
  built.applyRemember(
    { scope: 'session', pattern: bypass.command, patternKind: 'exact', allowUnsandboxed: true },
    bypass,
    'allow',
  );
  expect(await built.request(bypass)).toMatchObject({ decision: 'deny', denialSource: 'policy' });
  expect(asked).toEqual([]);
});

it.each([
  'legato-other plan status',
  'legato plan status; printf unwanted',
  'legato plan status && printf unwanted',
  'legato plan status | cat',
  'legato plan status > /tmp/result',
  'legato plan status $(printf unwanted)',
  'legato plan status `printf unwanted`',
  'legato plan "$ACTION"',
  'env legato plan status',
  'bash -c "legato plan status"',
  'legato plan "unterminated',
])('a prefix bypass rule requires fresh approval for %s', async (command) => {
  const { gate: built, asked } = gate([]);
  const bypass = request({ unsandboxed: true, command: 'legato plan status' });
  built.applyRemember(
    { scope: 'session', pattern: 'legato', patternKind: 'prefix', allowUnsandboxed: true },
    bypass,
    'allow',
  );
  await built.request({ ...bypass, command });
  expect(asked).toHaveLength(1);
});

it('does not admit bypasses through a glob even when its rule has the bypass flag', async () => {
  const { gate: built, asked } = gate([]);
  const bypass = request({ unsandboxed: true, command: 'legato plan status; printf unwanted' });
  built.applyRemember(
    { scope: 'session', pattern: 'legato*', patternKind: 'glob', allowUnsandboxed: true },
    bypass,
    'allow',
  );
  await built.request(bypass);
  expect(asked).toHaveLength(1);
});

it.each([
  false,
  true,
])('never lets the AI reviewer grant a bypass (headless=%s)', async (headless) => {
  const { gate: built, asked } = gate([], {
    headlessAutoDeny: headless,
    reviewer: { review: async () => ({ decision: 'allow', reason: 'ordinary host command' }) },
  });
  expect(await built.request(request({ unsandboxed: true }))).toMatchObject(
    headless ? { decision: 'deny', denialSource: 'headless' } : { decision: 'allow' },
  );
  expect(asked).toHaveLength(headless ? 0 : 1);
});

it('authorizes an automatic retry only under an explicit bypass rule, without asking the user', async () => {
  const { gate: built, asked, audited } = gate([], { autoApprove: 'all' });
  const retry = request({
    command: 'legato plan status',
    reason: 'retry blocked host database write',
  });
  expect(await built.requestRememberedBypass(retry)).toBeNull();
  built.applyRemember(
    { scope: 'session', pattern: 'legato', patternKind: 'prefix', allowUnsandboxed: true },
    { ...retry, unsandboxed: true },
    'allow',
  );
  expect(await built.requestRememberedBypass(retry)).toMatchObject({
    decision: 'allow',
    remembered: true,
  });
  expect(asked).toEqual([]);
  expect(audited).toMatchObject([
    { source: 'rule', request: { unsandboxed: true, osSandbox: false } },
  ]);
});

it.each([
  riskFinding,
  pathFinding,
  sudoFinding,
])('refuses automatic retries with another mandatory finding: $stageId', async (finding) => {
  const { gate: built, asked } = gate([finding], {
    reviewer: { review: async () => ({ decision: 'allow', reason: 'allow everything' }) },
  });
  const retry = request({ command: 'legato plan status' });
  built.addRule(
    {
      tool: 'bash',
      target: 'host',
      pattern: 'legato',
      patternKind: 'prefix',
      allowUnsandboxed: true,
      decision: 'allow',
      createdAt: 1,
    },
    'session',
  );
  expect(await built.requestRememberedBypass(retry)).toBeNull();
  expect(asked).toEqual([]);
});

it('does not treat an ordinary allow rule as automatic retry authorization', async () => {
  const { gate: built, asked } = gate([]);
  const retry = request({ command: 'legato plan status' });
  built.addRule(
    {
      tool: 'bash',
      target: 'host',
      pattern: 'legato',
      patternKind: 'prefix',
      decision: 'allow',
      createdAt: 1,
    },
    'session',
  );
  expect(await built.requestRememberedBypass(retry)).toBeNull();
  expect(asked).toEqual([]);
});

it('honors deny rules during automatic retry authorization', async () => {
  const { gate: built, asked } = gate([]);
  const retry = request({ command: 'legato plan status' });
  built.addRule(
    {
      tool: 'bash',
      target: 'host',
      pattern: 'legato',
      patternKind: 'prefix',
      allowUnsandboxed: true,
      decision: 'allow',
      createdAt: 1,
    },
    'session',
  );
  built.addRule(
    {
      tool: 'bash',
      target: 'host',
      pattern: retry.command,
      patternKind: 'exact',
      decision: 'deny',
      createdAt: 2,
    },
    'session',
  );
  expect(await built.requestRememberedBypass(retry)).toMatchObject({
    decision: 'deny',
    denialSource: 'rule',
  });
  expect(asked).toEqual([]);
});

it.each([
  'policy',
  'grant',
  'deny',
])('reevaluates a changed %s before a host retry', async (change) => {
  const findings: CommandPolicyFinding[] = [];
  const review = vi.fn(async () => ({ decision: 'allow' as const, reason: 'ordinary allow' }));
  const { gate: built, asked } = gate(findings, {
    autoApprove: 'all',
    headlessAutoDeny: true,
    reviewer: { review },
  });
  const initial = request({ command: 'legato plan status', osSandbox: true });
  built.addRule(
    {
      tool: 'bash',
      target: 'host',
      pattern: 'legato',
      patternKind: 'prefix',
      allowUnsandboxed: true,
      decision: 'allow',
      createdAt: 1,
    },
    'session',
  );
  expect(await built.request(initial)).toMatchObject({ decision: 'allow' });
  if (change === 'policy') findings.push(riskFinding);
  if (change === 'grant') built.removeRule(0);
  if (change === 'deny')
    built.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: initial.command,
        patternKind: 'exact',
        decision: 'deny',
        createdAt: 2,
      },
      'session',
    );
  const resolution = await built.requestRememberedBypass(initial);
  if (change === 'deny') expect(resolution).toMatchObject({ decision: 'deny' });
  else expect(resolution).toBeNull();
  expect(asked).toEqual([]);
  expect(review).not.toHaveBeenCalled();
});
