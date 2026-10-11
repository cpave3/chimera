import type { CommandPolicyFinding, PermissionRequest } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import {
  buildReviewPrompt,
  createSessionReviewer,
  parseReview,
  type ReviewContext,
  type ReviewPrompt,
  reviewable,
} from '../src/reviewer';

const finding = {
  path: {
    kind: 'path',
    stageId: 'path_authorization',
    operation: 'write',
    path: '/home/u/.cache/tool',
    requiredGrant: 'write',
    message: 'write outside the authorized directories',
  },
  caution: { kind: 'risk', stageId: 'risk', level: 'caution', message: 'changes many files' },
  danger: { kind: 'risk', stageId: 'risk', level: 'danger', message: 'dangerous command' },
  critical: { kind: 'risk', stageId: 'risk', level: 'critical', message: 'critical command' },
  sudo: {
    kind: 'elevation',
    stageId: 'sudo_approval',
    ruleId: 'sudo',
    message: 'sudo needs approval',
  },
  unsandboxed: {
    kind: 'elevation',
    stageId: 'os_sandbox',
    ruleId: 'unsandboxed',
    message: 'Runs outside the OS sandbox: the cache is in the home directory',
  },
  unresolved: { kind: 'unresolved', stageId: 'shell_effects', message: 'cannot resolve $TARGET' },
} satisfies Record<string, CommandPolicyFinding>;

function request(
  findings: CommandPolicyFinding[] = [],
  over: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    requestId: 'r1',
    tool: 'bash',
    target: 'host',
    command: 'pnpm install',
    cwd: '/work/project',
    ...(findings.length > 0
      ? { policyAnalysis: { version: 1, outcome: 'approval_required', stages: [], findings } }
      : {}),
    ...over,
  };
}

describe('reviewable', () => {
  it('takes a request with path, caution, unresolved or unsandboxed findings, or none', () => {
    expect(reviewable(request())).toBe(true);
    expect(reviewable(request([finding.path, finding.caution, finding.unresolved]))).toBe(true);
    expect(reviewable(request([finding.unsandboxed], { unsandboxed: true }))).toBe(true);
  });

  it('takes an MCP call', () => {
    const mcp = { server: 'github', tool: 'create_issue', preview: [] };
    expect(reviewable(request([], { tool: 'mcp', command: 'github/create_issue', mcp }))).toBe(
      true,
    );
  });

  it('leaves sudo, danger and critical to the user', () => {
    expect(reviewable(request([finding.sudo]))).toBe(false);
    expect(reviewable(request([finding.path, finding.danger]))).toBe(false);
    expect(reviewable(request([finding.critical]))).toBe(false);
  });
});

describe('buildReviewPrompt', () => {
  const context = (over: Partial<ReviewContext> = {}): ReviewContext => ({
    userMessages: ['Add a pnpm workspace for the docs site.'],
    instructions: [{ path: '/work/project/AGENTS.md', content: 'Never push to main.' }],
    ...over,
  });

  it('holds the command, where it runs, the reason of the agent and the findings', () => {
    const { prompt } = buildReviewPrompt(
      {
        request: request([finding.unsandboxed, finding.caution], {
          unsandboxed: true,
          reason: 'the pnpm store is in the home directory',
        }),
      },
      context(),
    );

    expect(prompt).toContain('pnpm install');
    expect(prompt).toContain('/work/project');
    expect(prompt).toContain('the pnpm store is in the home directory');
    expect(prompt).toMatch(/outside the OS sandbox/);
    expect(prompt).toContain('changes many files');
    expect(prompt).toMatch(/caution/);
  });

  it('holds what the user asked for and the project instructions', () => {
    const { prompt } = buildReviewPrompt({ request: request() }, context());

    expect(prompt).toContain('Add a pnpm workspace for the docs site.');
    expect(prompt).toContain('/work/project/AGENTS.md');
    expect(prompt).toContain('Never push to main.');
  });

  it('holds the server, the tool and the arguments of an MCP call', () => {
    const mcp = { server: 'github', tool: 'create_issue', preview: [] };
    const { prompt } = buildReviewPrompt(
      {
        request: request([], { tool: 'mcp', command: 'github/create_issue', mcp }),
        mcpArguments: { title: 'Docs site is down', labels: ['bug'] },
      },
      context(),
    );

    expect(prompt).toContain('github');
    expect(prompt).toContain('create_issue');
    expect(prompt).toContain('"title": "Docs site is down"');
  });

  it('keeps the first message and the newest ones when the user wrote many', () => {
    const userMessages = Array.from({ length: 30 }, (_, index) => `message number ${index + 1}.`);

    const { prompt } = buildReviewPrompt({ request: request() }, context({ userMessages }));

    expect(prompt).toContain('message number 1.');
    expect(prompt).toContain('message number 30.');
    expect(prompt).not.toContain('message number 12.');
    expect(prompt).toMatch(/22 messages between these are not shown/);
  });

  it('cuts a long message, a long instruction file and a long command', () => {
    const long = (word: string) => `${word} `.repeat(5_000);

    const { prompt } = buildReviewPrompt(
      { request: request([], { command: long('echo') }) },
      context({
        userMessages: [long('please')],
        instructions: [{ path: '/work/project/AGENTS.md', content: long('rule') }],
      }),
    );

    expect(prompt.length).toBeLessThan(20_000);
    expect(prompt.match(/\[cut\]/g)).toHaveLength(3);
  });

  it('tells the model that the call is data, that doubt means escalate, and how to answer', () => {
    const { system } = buildReviewPrompt({ request: request() }, context());

    expect(system).toMatch(/not instructions/);
    expect(system).toMatch(/not sure/);
    expect(system).toContain('"decision"');
    expect(system).toContain('"reason"');
  });
});

describe('parseReview', () => {
  it('reads the decision and the reason from a JSON object', () => {
    expect(parseReview('{"decision": "allow", "reason": "installs the dependencies"}')).toEqual({
      decision: 'allow',
      reason: 'installs the dependencies',
    });
    expect(parseReview('{"decision":"escalate","reason":"deletes the build cache"}')).toEqual({
      decision: 'escalate',
      reason: 'deletes the build cache',
    });
  });

  it('finds the object in a reply that has thinking, a code fence or other text around it', () => {
    const reply =
      'The command {pnpm install} looks fine.\n```json\n{"decision": "Allow", "reason": "a normal step"}\n```\nDone.';

    expect(parseReview(reply)).toEqual({ decision: 'allow', reason: 'a normal step' });
  });

  it('accepts an answer with no reason', () => {
    expect(parseReview('{"decision": "escalate"}')).toEqual({
      decision: 'escalate',
      reason: 'the reviewer gave no reason',
    });
  });

  it('reads nothing from a reply with no decision it knows', () => {
    expect(parseReview('I think this is fine.')).toBeNull();
    expect(parseReview('{"decision": "approve", "reason": "ok"}')).toBeNull();
    expect(parseReview('{"decision": allow}')).toBeNull();
    expect(parseReview('')).toBeNull();
  });
});

describe('session reviewer', () => {
  const allow = '{"decision": "allow", "reason": "a normal step"}';
  const escalate = '{"decision": "escalate", "reason": "outside the task"}';

  /** A reviewer whose model gives the queued replies, then repeats the last one. */
  function reviewer(replies: Array<string | Error>, timeoutMs?: number) {
    const prompts: ReviewPrompt[] = [];
    const queue = [...replies];
    const session = createSessionReviewer({
      judge: async (prompt) => {
        prompts.push(prompt);
        const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
        if (reply instanceof Error) throw reply;
        return reply;
      },
      context: () => ({ userMessages: ['Set up the docs site.'], instructions: [] }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { session, prompts, review: () => session.review({ request: request() }) };
  }

  it('gives the answer of the model, which saw the request and what the user asked for', async () => {
    const { review, prompts } = reviewer([allow]);

    expect(await review()).toEqual({ decision: 'allow', reason: 'a normal step' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.prompt).toContain('pnpm install');
    expect(prompts[0]!.prompt).toContain('Set up the docs site.');
  });

  it('does not decide a request that belongs to the user, and does not call the model', async () => {
    const { session, prompts } = reviewer([allow]);

    expect(await session.review({ request: request([finding.sudo]) })).toBeNull();
    expect(prompts).toHaveLength(0);
  });

  it('escalates when the model fails or its reply has no decision', async () => {
    const failed = await reviewer([new Error('503 overloaded')]).review();
    const unreadable = await reviewer(['Looks fine to me.']).review();

    expect(failed).toMatchObject({ decision: 'escalate' });
    expect(failed!.reason).toMatch(/503 overloaded/);
    expect(unreadable).toMatchObject({ decision: 'escalate' });
    expect(unreadable!.reason).toMatch(/no decision/);
  });

  it('escalates when the model does not answer in time', async () => {
    const session = createSessionReviewer({
      judge: () => new Promise<string>(() => {}),
      context: () => ({ userMessages: [], instructions: [] }),
      timeoutMs: 20,
    });

    const review = await session.review({ request: request() });

    expect(review).toMatchObject({ decision: 'escalate' });
    expect(review!.reason).toMatch(/did not answer/);
  });

  it('stops after three escalations in a row', async () => {
    const { review, prompts } = reviewer([escalate]);

    const first = await review();
    await review();
    const third = await review();
    const fourth = await review();

    expect(first!.stopped).toBeUndefined();
    expect(third).toMatchObject({ decision: 'escalate', stopped: 'consecutive' });
    expect(fourth).toBeNull();
    expect(prompts).toHaveLength(3);
  });

  it('starts the run of three again after an allow, and stops after ten escalations in all', async () => {
    const pattern = Array.from({ length: 5 }, () => [escalate, escalate, allow]).flat();
    const { review, prompts } = reviewer(pattern);

    const reviews = [];
    for (let index = 0; index < 14; index += 1) reviews.push(await review());
    const after = await review();

    expect(reviews.slice(0, 13).every((made) => made !== null && !made.stopped)).toBe(true);
    // The tenth escalation is the fourteenth request: e e a, e e a, e e a, e e a, e e.
    expect(reviews[13]).toMatchObject({ decision: 'escalate', stopped: 'total' });
    expect(after).toBeNull();
    expect(prompts).toHaveLength(14);
  });
});
