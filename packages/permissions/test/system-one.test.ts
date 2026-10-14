import type { CommandPolicyFinding, PermissionRequest } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { createSystemOneCheck, type SystemOneOptions } from '../src/system-one';

const URL = 'http://system-one.test/v1/systemone';

function request(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'r1',
    tool: 'bash',
    target: 'host',
    command: './dev check > /tmp/check.log 2>&1; tail -20 /tmp/check.log',
    cwd: '/work/shop',
    ...over,
  };
}

/** The answers of a model that gives each question this probability of the harmless reading. */
function answers(benign: number, likelyKind = 'develops') {
  const rest = 1 - benign;
  return {
    damage: {
      type: 'score',
      score: 1,
      probabilities: { '0': benign / 2, '1': benign / 2, '2': rest / 2, '3': rest / 2 },
    },
    kind: {
      type: 'choice',
      choice: likelyKind,
      probabilities:
        likelyKind === 'develops'
          ? { reads: 0, develops: benign, destroys: rest, leaks: 0, remote: 0, system: 0 }
          : {
              reads: benign,
              develops: 0,
              destroys: 0,
              leaks: 0,
              remote: 0,
              system: 0,
              [likelyKind]: rest,
            },
    },
    verdict: { type: 'choice', choice: 'safe', probabilities: { safe: benign, unsafe: rest } },
  };
}

/** A System One server that replies as told, and the requests it got. */
function server(reply: () => Response | Promise<Response>) {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: { model: string; state: unknown; questions: Record<string, unknown> };
  }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    });
    return reply();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const replying = (body: unknown, status = 200) =>
  server(() => new Response(JSON.stringify(body), { status }));

function check(fetch: typeof globalThis.fetch, over: Partial<SystemOneOptions> = {}) {
  return createSystemOneCheck({ url: URL, threshold: 0.8, fetch, ...over });
}

describe('the System One check', () => {
  it('allows a command that the model rates above the threshold', async () => {
    const { fetch, calls } = replying({ model: 'jev-1.13', answers: answers(0.9) });

    const verdict = await check(fetch).check(request());

    expect(verdict).toMatchObject({ decision: 'allow', threshold: 0.8 });
    expect(verdict!.safety).toBeCloseTo(0.9);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL);
    expect(calls[0]!.body.state).toEqual({
      working_directory: '/work/shop',
      bash_command: './dev check > /tmp/check.log 2>&1; tail -20 /tmp/check.log',
    });
    expect(Object.keys(calls[0]!.body.questions)).toEqual(['damage', 'kind', 'verdict']);
  });

  it('rejects a command that the model rates below the threshold, and says what it reads as', async () => {
    const { fetch } = replying({ model: 'jev-1.13', answers: answers(0.3, 'remote') });

    const verdict = await check(fetch).check(request({ command: 'vercel deploy --prod' }));

    expect(verdict).toMatchObject({
      decision: 'escalate',
      note: 'rejected: safety 0.30, needs 0.80, reads as "remote"',
    });
  });

  it('rejects a command rated exactly between: the threshold itself passes, less does not', async () => {
    expect(
      (await check(replying({ answers: answers(0.8) }).fetch).check(request()))!.decision,
    ).toBe('allow');
    expect(
      (await check(replying({ answers: answers(0.79) }).fetch).check(request()))!.decision,
    ).toBe('escalate');
  });

  it('sends the model name and the API key that the settings give', async () => {
    const { fetch, calls } = replying({ answers: answers(0.9) });

    await check(fetch, { model: 'typesafe/jev-1.13', apiKey: () => 'secret-key' }).check(request());

    expect(calls[0]!.body.model).toBe('typesafe/jev-1.13');
    expect(calls[0]!.headers.authorization).toBe('Bearer secret-key');
  });

  describe('requests it does not decide', () => {
    const sudo: CommandPolicyFinding = {
      kind: 'elevation',
      stageId: 'sudo_approval',
      ruleId: 'sudo',
      message: 'runs as root',
    };
    const danger: CommandPolicyFinding = {
      kind: 'risk',
      stageId: 'risk',
      level: 'danger',
      message: 'force push',
    };
    const withFindings = (findings: CommandPolicyFinding[]) =>
      request({
        policyAnalysis: { version: 1, outcome: 'approval_required', stages: [], findings },
      });

    it.each([
      ['a sudo command', withFindings([sudo])],
      ['a command with a danger finding', withFindings([danger])],
      ['a command of another tool', request({ tool: 'write' })],
      [
        'an MCP call',
        request({ tool: 'mcp', mcp: { server: 'files', tool: 'delete', preview: [] } }),
      ],
      ['a request to leave the OS sandbox', request({ unsandboxed: true, reason: 'needs docker' })],
    ])('leaves %s to the user without asking the model', async (_name, undecided) => {
      const { fetch, calls } = replying({ answers: answers(0.99) });

      expect(await check(fetch).check(undecided)).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('decides a request to leave the OS sandbox when the settings allow that', async () => {
      const { fetch } = replying({ answers: answers(0.9) });

      const verdict = await check(fetch, { allowSandboxBypass: true }).check(
        request({ unsandboxed: true, reason: 'needs docker' }),
      );

      expect(verdict).toMatchObject({ decision: 'allow' });
    });
  });

  describe('when the model gives no answer', () => {
    it('leaves the decision to the user after an HTTP error', async () => {
      const { fetch } = replying({ detail: 'model not loaded' }, 503);

      const verdict = await check(fetch).check(request());

      expect(verdict).toEqual({
        decision: 'escalate',
        failed: true,
        note: 'gave no answer: HTTP 503',
        threshold: 0.8,
      });
    });

    it('leaves the decision to the user when the server cannot be reached', async () => {
      const { fetch } = server(() => {
        throw new Error('connect ECONNREFUSED');
      });

      const verdict = await check(fetch).check(request());

      expect(verdict).toMatchObject({
        decision: 'escalate',
        failed: true,
        note: 'gave no answer: connect ECONNREFUSED',
      });
    });

    it('says why the server could not be reached when the error has a cause', async () => {
      const { fetch } = server(() => {
        throw new TypeError('fetch failed', {
          cause: new Error('connect ECONNREFUSED 127.0.0.1:9'),
        });
      });

      const verdict = await check(fetch).check(request());

      expect(verdict!.note).toBe('gave no answer: fetch failed (connect ECONNREFUSED 127.0.0.1:9)');
    });

    it('leaves the decision to the user when the reply lacks a probability', async () => {
      const { fetch } = replying({
        answers: { ...answers(0.9), verdict: { type: 'choice', choice: 'safe' } },
      });

      const verdict = await check(fetch).check(request());

      expect(verdict).toMatchObject({
        decision: 'escalate',
        failed: true,
        note: 'gave no answer: the reply has no probabilities for "verdict"',
      });
    });

    it.each([
      ['a probability that is not a number', { safe: 'high', unsafe: 'low' }],
      ['no option at all', {}],
    ])('leaves the decision to the user when an answer has %s', async (_name, probabilities) => {
      const broken = { ...answers(0.9), kind: { type: 'choice', probabilities } };
      const { fetch } = replying({ answers: broken });

      const verdict = await check(fetch).check(request());

      expect(verdict).toMatchObject({ decision: 'escalate', failed: true });
      expect(verdict!.note).toMatch(
        /^gave no answer: the reply has no usable probabilities for "kind"/,
      );
    });

    it('does not wait longer than the time limit', async () => {
      const { fetch } = server(() => new Promise<Response>(() => {}));

      const verdict = await check(fetch, { timeoutMs: 20 }).check(request());

      expect(verdict).toMatchObject({
        decision: 'escalate',
        failed: true,
        note: 'gave no answer: no reply in 20 ms',
      });
    });
  });
});
