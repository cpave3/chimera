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
import type { ApprovalReview } from '../src/reviewer';
import type { SystemOneVerdict } from '../src/system-one';

const pathFinding: CommandPolicyFinding = {
  kind: 'path',
  stageId: 'path_authorization',
  operation: 'write',
  path: '/home/u/.cache/tool',
  requiredGrant: 'write',
  message: 'write outside the authorized directories',
};

const approved: SystemOneVerdict = {
  decision: 'allow',
  note: 'approved: safety 0.91, needs 0.80',
  safety: 0.91,
  threshold: 0.8,
};
const rejected: SystemOneVerdict = {
  decision: 'escalate',
  note: 'rejected: safety 0.31, needs 0.80, reads as "remote"',
  safety: 0.31,
  threshold: 0.8,
};
const unanswered: SystemOneVerdict = {
  decision: 'escalate',
  failed: true,
  note: 'gave no answer: HTTP 503',
  threshold: 0.8,
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'chimera-gate-system-one-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function request(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return { requestId: 'r1', tool: 'bash', target: 'host', command: 'make cache', cwd, ...over };
}

/**
 * A gate whose policy reports a path finding, whose System One check answers
 * as told, and whose user allows.
 */
function gate(verdict: SystemOneVerdict | null, over: Partial<GateOptions> = {}) {
  const asked: PermissionRequest[] = [];
  const checked: PermissionRequest[] = [];
  const reported: Array<{ request: PermissionRequest; verdict: SystemOneVerdict }> = [];
  const audited: Array<{
    source: PermissionDecisionSource;
    decision: string;
    systemOne?: SystemOneVerdict;
  }> = [];
  const built = new DefaultPermissionGate({
    cwd,
    home: join(cwd, 'home'),
    autoApprove: 'none',
    commandPolicy: {
      evaluator: {
        async evaluate() {
          return {
            version: 1,
            outcome: 'approval_required',
            stages: [],
            findings: [pathFinding],
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
    systemOne: {
      check: async (checkedRequest) => {
        checked.push(checkedRequest);
        return verdict;
      },
    },
    onSystemOne: (checkedRequest, made) =>
      reported.push({ request: checkedRequest, verdict: made }),
    audit: (entry) =>
      audited.push({
        source: entry.source,
        decision: entry.resolution.decision,
        ...(entry.systemOne ? { systemOne: entry.systemOne } : {}),
      }),
    ...over,
  });
  return { gate: built, asked, checked, reported, audited };
}

describe('the System One check in the gate', () => {
  it('runs a command the check approves, and the user is not asked', async () => {
    const { gate: built, asked, checked, reported, audited } = gate(approved);

    const resolution = await built.request(request({ toolCallId: 'call-7' }));

    expect(resolution).toMatchObject({ decision: 'allow', remembered: false });
    expect(asked).toHaveLength(0);
    expect(checked[0]).toMatchObject({
      command: 'make cache',
      policyAnalysis: { findings: [pathFinding] },
    });
    expect(reported).toEqual([
      { request: expect.objectContaining({ toolCallId: 'call-7' }), verdict: approved },
    ]);
    expect(audited).toEqual([{ source: 'system_one', decision: 'allow', systemOne: approved }]);
  });

  it('asks the user about a command the check rejects, with a note that it did', async () => {
    const reviews: unknown[] = [];
    const {
      gate: built,
      asked,
      reported,
      audited,
    } = gate(rejected, {
      reviewer: {
        review: async (input) => {
          reviews.push(input);
          return { decision: 'allow', reason: 'looks fine' };
        },
      },
    });

    const resolution = await built.request(request());

    expect(resolution.decision).toBe('allow');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.systemOneNote).toBe('rejected: safety 0.31, needs 0.80, reads as "remote"');
    // A rejection is for the user: the reviewer does not get to overrule it.
    expect(reviews).toHaveLength(0);
    expect(reported).toEqual([{ request: expect.anything(), verdict: rejected }]);
    expect(audited).toEqual([{ source: 'user', decision: 'allow', systemOne: rejected }]);
  });

  it('goes on to the reviewer and the user when the check gave no answer', async () => {
    const escalate: ApprovalReview = { decision: 'escalate', reason: 'writes outside the task' };
    const {
      gate: built,
      asked,
      audited,
    } = gate(unanswered, {
      reviewer: { review: async () => escalate },
    });

    await built.request(request());

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      systemOneNote: 'gave no answer: HTTP 503',
      reviewerReason: 'writes outside the task',
    });
    expect(audited).toEqual([{ source: 'user', decision: 'allow', systemOne: unanswered }]);
  });

  it('asks the user as before about a request the check does not decide', async () => {
    const { gate: built, asked, reported, audited } = gate(null);

    await built.request(request());

    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toHaveProperty('systemOneNote');
    expect(reported).toHaveLength(0);
    expect(audited).toEqual([{ source: 'user', decision: 'allow' }]);
  });

  it('denies a rejected command with the note when nobody can be asked', async () => {
    const { gate: built, asked, audited } = gate(rejected, { headlessAutoDeny: true });

    const resolution = await built.request(request());

    expect(resolution).toMatchObject({
      decision: 'deny',
      denialSource: 'system_one',
      systemOneNote: 'rejected: safety 0.31, needs 0.80, reads as "remote"',
    });
    expect(asked).toHaveLength(0);
    expect(audited).toEqual([{ source: 'system_one', decision: 'deny', systemOne: rejected }]);
  });

  it('gives an unanswered command the plain headless denial when nobody can be asked', async () => {
    const { gate: built } = gate(unanswered, { headlessAutoDeny: true });

    expect(await built.request(request())).toMatchObject({
      decision: 'deny',
      denialSource: 'headless',
    });
  });

  it('does not ask the check about a command that a hook blocks', async () => {
    const permissionRequest = async () => ({ blocked: true });
    const { gate: built, checked } = gate(approved, { permissionRequest });

    expect(await built.request(request())).toMatchObject({
      decision: 'deny',
      denialSource: 'hook',
    });
    expect(checked).toHaveLength(0);
  });

  it('does not ask the check about a command that a deny rule matches', async () => {
    const { gate: built, checked } = gate(approved);
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

    expect(await built.request(request())).toMatchObject({
      decision: 'deny',
      denialSource: 'rule',
    });
    expect(checked).toHaveLength(0);
  });

  describe('the host retry after an OS sandbox failure', () => {
    const retry = () =>
      request({ unsandboxed: true, reason: 'Automatic host retry after an OS sandbox failure.' });

    it('retries a command the check approves, without asking the user', async () => {
      const { gate: built, asked, checked, audited } = gate(approved);

      const resolution = await built.requestRememberedBypass(retry());

      expect(resolution).toMatchObject({ decision: 'allow', remembered: false });
      expect(asked).toHaveLength(0);
      expect(checked[0]).toMatchObject({ command: 'make cache', unsandboxed: true });
      expect(audited).toEqual([{ source: 'system_one', decision: 'allow', systemOne: approved }]);
    });

    it.each([
      false,
      true,
    ])('settles the automatic retry lifecycle (hook blocks=%s)', async (blocked) => {
      const lifecycle: string[] = [];
      let releaseHook!: () => void;
      let enterHook!: () => void;
      const hookBlocked = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      const hookEntered = new Promise<void>((resolve) => {
        enterHook = resolve;
      });
      const permissionRequest = async () => {
        lifecycle.push('waiting');
        return { blocked };
      };
      const { gate: built, asked } = gate(approved, {
        permissionRequest,
        emitResolved: async (requestId, decision, remembered) => {
          enterHook();
          await hookBlocked;
          lifecycle.push(`${requestId}:${decision}:${remembered}`);
        },
      });

      const completion = built.requestRememberedBypass(retry()).then((resolution) => {
        lifecycle.push('resumed');
        return resolution;
      });
      await hookEntered;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(lifecycle).toEqual(['waiting']);
      releaseHook();
      const resolution = await completion;

      expect(asked).toHaveLength(0);
      const decision = blocked ? 'deny' : 'allow';
      expect(resolution?.decision).toBe(decision);
      expect(lifecycle).toEqual(['waiting', `r1:${decision}:false`, 'resumed']);
    });

    it.each([
      ['rejects', rejected],
      ['gave no answer about', unanswered],
      ['does not decide', null],
    ])('does not retry a command the check %s, and does not ask the user', async (_name, verdict) => {
      const { gate: built, asked, audited } = gate(verdict);

      expect(await built.requestRememberedBypass(retry())).toBeNull();
      expect(asked).toHaveLength(0);
      expect(audited).toHaveLength(0);
    });

    it('does not retry an approved command that a hook blocks', async () => {
      const permissionRequest = async () => ({ blocked: true });
      const { gate: built } = gate(approved, { permissionRequest });

      expect(await built.requestRememberedBypass(retry())).toMatchObject({
        decision: 'deny',
        denialSource: 'hook',
      });
    });
  });
});
