import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandPolicyFinding,
  Executor,
  PermissionDecisionSource,
  PermissionRequest,
  PermissionResolution,
} from '@chimera/core';
import type { HookRunner } from '@chimera/hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultPermissionGate, type GateOptions } from '../src/gate';
import { GatedExecutor } from '../src/gated-executor';
import type { ApprovalReview, ReviewInput } from '../src/reviewer';

const pathFinding: CommandPolicyFinding = {
  kind: 'path',
  stageId: 'path_authorization',
  operation: 'write',
  path: '/home/u/.cache/tool',
  requiredGrant: 'write',
  message: 'write outside the authorized directories',
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'chimera-gate-reviewer-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function request(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return { requestId: 'r1', tool: 'bash', target: 'host', command: 'make cache', cwd, ...over };
}

/**
 * A gate whose policy reports a path finding, whose reviewer answers as
 * told, and whose user allows.
 */
function gate(review: ApprovalReview | null, over: Partial<GateOptions> = {}) {
  const asked: PermissionRequest[] = [];
  const reviewed: ReviewInput[] = [];
  const reported: Array<{ request: PermissionRequest; review: ApprovalReview }> = [];
  const audited: Array<{
    source: PermissionDecisionSource;
    decision: string;
    review?: ApprovalReview;
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
    reviewer: {
      review: async (input) => {
        reviewed.push(input);
        return review;
      },
    },
    onReview: (reviewedRequest, made) => reported.push({ request: reviewedRequest, review: made }),
    audit: (entry) =>
      audited.push({
        source: entry.source,
        decision: entry.resolution.decision,
        ...(entry.review ? { review: entry.review } : {}),
      }),
    ...over,
  });
  return { gate: built, asked, reviewed, reported, audited };
}

const allow: ApprovalReview = { decision: 'allow', reason: 'builds the cache the task needs' };
const escalate: ApprovalReview = { decision: 'escalate', reason: 'writes outside the task' };

describe('the approval reviewer in the gate', () => {
  it('allows a request the reviewer allows, and the user is not asked', async () => {
    const resolved: string[] = [];
    const {
      gate: built,
      asked,
      reviewed,
      reported,
      audited,
    } = gate(allow, {
      emitResolved: async (requestId, decision) => {
        await Promise.resolve();
        resolved.push(`${requestId}:${decision}`);
      },
    });

    const resolution = await built.request(request({ toolCallId: 'call-7' }));

    expect(resolution).toMatchObject({ decision: 'allow', remembered: false });
    expect(asked).toHaveLength(0);
    expect(resolved).toEqual(['r1:allow']);
    expect(reviewed[0]!.request).toMatchObject({
      command: 'make cache',
      policyAnalysis: { findings: [pathFinding] },
    });
    expect(reported).toEqual([
      { request: expect.objectContaining({ toolCallId: 'call-7' }), review: allow },
    ]);
    expect(audited).toEqual([{ source: 'reviewer', decision: 'allow', review: allow }]);
  });

  it('asks the user about a request the reviewer escalates, with the reason of the reviewer', async () => {
    const { gate: built, asked, reported, audited } = gate(escalate);

    const resolution = await built.request(request());

    expect(resolution.decision).toBe('allow');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.reviewerReason).toBe('writes outside the task');
    expect(reported).toHaveLength(1);
    expect(audited).toEqual([{ source: 'user', decision: 'allow', review: escalate }]);
  });

  it('denies an escalated request with the reason when nobody can be asked', async () => {
    const { gate: built, asked, audited } = gate(escalate, { headlessAutoDeny: true });

    const resolution = await built.request(request());

    expect(resolution).toMatchObject({
      decision: 'deny',
      denialSource: 'reviewer',
      reviewerReason: 'writes outside the task',
    });
    expect(asked).toHaveLength(0);
    expect(audited).toEqual([{ source: 'reviewer', decision: 'deny', review: escalate }]);
  });

  it('gives a host command of another tool the same denial text', async () => {
    const { gate: built } = gate(escalate, { headlessAutoDeny: true });
    const inner = { cwd: () => cwd, target: () => 'host' } as unknown as Executor;

    const result = await new GatedExecutor({ inner, gate: built }).exec('make cache');

    expect(result.stderr).toBe('denied by reviewer: writes outside the task');
  });

  it('lets a headless session run what the reviewer allows', async () => {
    const { gate: built } = gate(allow, { headlessAutoDeny: true });

    expect((await built.request(request())).decision).toBe('allow');
  });

  it('asks the user as before when the request is not the reviewer`s to decide', async () => {
    const { gate: built, asked, reported, audited } = gate(null);

    await built.request(request());

    expect(asked).toHaveLength(1);
    expect(asked[0]!.reviewerReason).toBeUndefined();
    expect(reported).toHaveLength(0);
    expect(audited).toEqual([{ source: 'user', decision: 'allow' }]);
  });

  it('reviews an MCP call with its arguments', async () => {
    const { gate: built, asked, reviewed } = gate(allow);

    const resolution = await built.requestMcp({
      requestId: 'm1',
      server: 'github',
      tool: 'create_issue',
      cwd,
      args: { title: 'Docs site is down' },
      toolCallId: 'call-9',
    });

    expect(resolution.decision).toBe('allow');
    expect(asked).toHaveLength(0);
    expect(reviewed[0]).toMatchObject({
      request: { mcp: { server: 'github', tool: 'create_issue' }, toolCallId: 'call-9' },
      mcpArguments: { title: 'Docs site is down' },
    });
  });

  it('does not review what a rule, an auto-approve level or a hook decides', async () => {
    const blockingHook = {
      fire: async () => ({ blocked: true, blockingScript: '/hooks/no.sh', reason: 'no' }),
    } as unknown as HookRunner;
    const byRule = gate(allow);
    byRule.gate.addRule(
      {
        tool: 'mcp',
        target: 'host',
        pattern: 'github/create_issue',
        patternKind: 'exact',
        decision: 'deny',
        createdAt: 0,
      },
      'session',
    );
    const byLevel = gate(allow, { autoApprove: 'all', commandPolicy: undefined });
    const byHook = gate(allow, { hookRunner: blockingHook });

    const ruled = await byRule.gate.requestMcp({
      requestId: 'm1',
      server: 'github',
      tool: 'create_issue',
      cwd,
      args: {},
    });
    const levelled = await byLevel.gate.request(request());
    const hooked = await byHook.gate.request(request());

    expect(ruled).toMatchObject({ decision: 'deny', denialSource: 'rule' });
    expect(levelled.decision).toBe('allow');
    expect(hooked).toMatchObject({ decision: 'deny', denialSource: 'hook' });
    expect([...byRule.reviewed, ...byLevel.reviewed, ...byHook.reviewed]).toHaveLength(0);
  });
});
