import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliAgentFactory } from '../src/factory';

type ChatBody = {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: unknown }>;
};

/** One turn of the session model: a line of text, then a clean stop. */
function textTurn(text: string): Response {
  const chunk = (delta: unknown, reason: string | null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test',
      choices: [{ index: 0, delta, finish_reason: reason }],
    })}\n\n`;
  return new Response(
    `${chunk({ role: 'assistant', content: text }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/** The checker model's reply: one whole completion, not a stream. */
function completion(text: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-2',
      object: 'chat.completion',
      created: 0,
      model: 'test',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('goal check in a session', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-goal-'));
    home = await mkdtemp(join(tmpdir(), 'chimera-goal-home-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  interface Scenario {
    /** What the checker model replies, in order; the last one repeats. */
    verdicts: string[];
    utilityModel?: string | null;
    maxContinuations?: number;
    depth?: number;
  }

  async function run(scenario: Scenario) {
    const sessionCalls: ChatBody[] = [];
    const checkerCalls: ChatBody[] = [];
    const verdicts = [...scenario.verdicts];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if (!String(input).endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 });
      }
      const body = JSON.parse(String(init?.body)) as ChatBody;
      if (!body.stream) {
        checkerCalls.push(body);
        return completion(verdicts.length > 1 ? verdicts.shift()! : verdicts[0]!);
      }
      sessionCalls.push(body);
      return textTurn(`turn ${sessionCalls.length} is done`);
    });
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          direct: { shape: 'openai', baseUrl: 'https://provider.test/v1', apiKey: 'test-key' },
        },
      },
      models: {
        'direct/coder': { contextWindow: 64_000 },
        'direct/helper': { contextWindow: 64_000 },
      },
      autoApprove: 'all',
      ...(scenario.utilityModel === null
        ? {}
        : { utilityModel: scenario.utilityModel ?? 'direct/helper' }),
      ...(scenario.maxContinuations
        ? { goal: { maxContinuations: scenario.maxContinuations } }
        : {}),
      home,
      warn: () => {},
      subagents: { enabled: false, currentDepth: scenario.depth ?? 0 },
    });
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'direct', modelId: 'coder', maxSteps: 5 },
      sandboxMode: 'off',
    });
    agent.setGoal('the changelog has an entry for 2.0');
    const events: AgentEvent[] = [];
    for await (const event of agent.run('Write the changelog entry.')) events.push(event);
    const changes = events.flatMap((event) =>
      event.type === 'goal_updated' ? [event.change] : [],
    );
    const finished = events.at(-1) as Extract<AgentEvent, { type: 'run_finished' }>;
    return { changes, reason: finished.reason, sessionCalls, checkerCalls };
  }

  const met = '{"result": "met", "reason": "the entry is in the file"}';
  const notMet = '{"result": "not_met", "reason": "the file was not written"}';

  it('asks the utility model, tells the session model what is missing, and stops when the goal is met', async () => {
    const { changes, reason, sessionCalls, checkerCalls } = await run({ verdicts: [notMet, met] });

    expect(changes).toEqual(['not_met', 'met']);
    expect(reason).toBe('stop');
    expect(checkerCalls.map((call) => call.model)).toEqual(['helper', 'helper']);
    const seen = JSON.stringify(checkerCalls[0]!.messages);
    expect(seen).toContain('the changelog has an entry for 2.0');
    expect(seen).toContain('turn 1 is done');
    expect(sessionCalls).toHaveLength(2);
    expect(JSON.stringify(sessionCalls[1]!.messages)).toContain('the file was not written');
  });

  it('uses the session model when no utility model is set', async () => {
    const { checkerCalls } = await run({ verdicts: [met], utilityModel: null });

    expect(checkerCalls.map((call) => call.model)).toEqual(['coder']);
  });

  it('ends the run at the configured limit', async () => {
    const { changes, reason, sessionCalls } = await run({
      verdicts: [notMet],
      maxContinuations: 1,
    });

    expect(changes).toEqual(['not_met', 'limit']);
    expect(reason).toBe('max_steps');
    expect(sessionCalls).toHaveLength(2);
  });

  it('gives a subagent session no goal check', async () => {
    const { changes, checkerCalls, reason } = await run({ verdicts: [notMet], depth: 1 });

    expect(checkerCalls).toHaveLength(0);
    expect(changes).toEqual([]);
    expect(reason).toBe('stop');
  });
});
