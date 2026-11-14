import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel, ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, type AgentOptions } from '../src/agent';
import type { AgentEvent } from '../src/events';
import { parseGoalMessage } from '../src/goal';
import { LifecycleSource } from '../src/lifecycle';
import { loadSession } from '../src/persistence';

type GoalEvent = Extract<AgentEvent, { type: 'goal_updated' }>;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'chimera-agent-goal-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A model that ends each turn with one line of text, and counts its turns. */
function talkingModel() {
  const state = { turns: 0 };
  const model = new MockLanguageModelV3({
    doStream: async () => {
      state.turns += 1;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: `turn ${state.turns} is done` },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      };
    },
  }) as unknown as LanguageModel;
  return { model, state };
}

/**
 * An agent whose goal checker gives the queued replies, then repeats the
 * last one.
 */
function agentWith(replies: Array<string | Error>, over: Partial<AgentOptions> = {}) {
  const { model, state } = talkingModel();
  const asked: Array<{ system: string; prompt: string }> = [];
  const queue = [...replies];
  const agent = new Agent({
    cwd: '/tmp',
    model: { providerId: 'mock', modelId: 'm', maxSteps: 10 },
    languageModel: model,
    tools: {} as ToolSet,
    sandboxMode: 'off',
    home,
    contextWindow: 200_000,
    goalCheck: {
      ask: async (prompt) => {
        asked.push(prompt);
        const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
    ...over,
  });
  return { agent, asked, turns: state };
}

async function run(agent: Agent, message = 'make the tests pass') {
  const events: AgentEvent[] = [];
  for await (const event of agent.run(message)) events.push(event);
  const goalEvents = events.filter((event): event is GoalEvent => event.type === 'goal_updated');
  const finished = events.at(-1) as Extract<AgentEvent, { type: 'run_finished' }>;
  return { events, goalEvents, reason: finished.reason };
}

const met = '{"result": "met", "reason": "the test run passed"}';
const notMet = '{"result": "not_met", "reason": "the tests were not run"}';

describe('session goal', () => {
  it('is set, replaced and cleared, and each change is an event', () => {
    const { agent } = agentWith([met]);

    const set = agent.setGoal('  all tests pass  ');
    const replaced = agent.setGoal('the build is green');
    const cleared = agent.setGoal(null);

    expect(set).toEqual({ type: 'goal_updated', condition: 'all tests pass', change: 'set' });
    expect(replaced).toMatchObject({ condition: 'the build is green', change: 'set' });
    expect(cleared).toEqual({ type: 'goal_updated', condition: null, change: 'cleared' });
    expect(agent.session.goal).toBeUndefined();
  });

  it('comes back when the session is loaded again', async () => {
    const { agent } = agentWith([notMet], { goalCheck: undefined });
    agent.setGoal('all tests pass');
    await run(agent);

    const loaded = await loadSession(agent.session.id, home);

    expect(loaded.goal).toEqual({ condition: 'all tests pass' });
  });
});

describe('goal check at a clean stop', () => {
  it('does not run when the session has no goal', async () => {
    const { agent, asked, turns } = agentWith([notMet]);

    const { reason, goalEvents } = await run(agent);

    expect(asked).toHaveLength(0);
    expect(goalEvents).toHaveLength(0);
    expect(turns.turns).toBe(1);
    expect(reason).toBe('stop');
  });

  it('ends the run and removes the goal when the goal is met', async () => {
    const { agent, asked, turns } = agentWith([met]);
    agent.setGoal('all tests pass');

    const { reason, goalEvents } = await run(agent);

    expect(reason).toBe('stop');
    expect(turns.turns).toBe(1);
    expect(agent.session.goal).toBeUndefined();
    expect(goalEvents).toEqual([
      { type: 'goal_updated', condition: null, change: 'met', reason: 'the test run passed' },
    ]);
    expect(asked[0]!.prompt).toContain('all tests pass');
    expect(asked[0]!.prompt).toContain('turn 1 is done');
  });
});

describe('a goal that is not met', () => {
  it('tells the agent what is missing and lets it work on', async () => {
    const { agent, turns } = agentWith([notMet, met]);
    agent.setGoal('all tests pass');

    const { reason, goalEvents, events } = await run(agent);

    expect(
      events.filter((event) => event.type === 'user_message').map((event) => event.source),
    ).toEqual(['user', 'goal']);
    expect(turns.turns).toBe(2);
    expect(reason).toBe('stop');
    expect(goalEvents.map((event) => event.change)).toEqual(['not_met', 'met']);
    expect(goalEvents[0]).toEqual({
      type: 'goal_updated',
      condition: 'all tests pass',
      change: 'not_met',
      reason: 'the tests were not run',
      continuation: 1,
      maxContinuations: 20,
    });
    const told = agent.session.messages
      .filter((message) => message.role === 'user')
      .map((message) => String(message.content));
    expect(parseGoalMessage(told[1]!)).toEqual({
      continuation: 1,
      maxContinuations: 20,
      reason: 'the tests were not run',
    });
    expect(told[1]).toContain('all tests pass');
    // The message goes out as an event too, so a client can show it.
    expect(
      events.filter((event) => event.type === 'user_message').map((event) => event.content),
    ).toEqual(['make the tests pass', told[1]]);
  });

  it('ends the run with max_steps at the limit and keeps the goal', async () => {
    const { agent, asked, turns } = agentWith([notMet], {});
    agent.setGoal('all tests pass');
    (agent as unknown as { opts: AgentOptions }).opts.goalCheck!.maxContinuations = 2;

    const { reason, goalEvents } = await run(agent);

    expect(turns.turns).toBe(3);
    expect(asked).toHaveLength(3);
    expect(reason).toBe('max_steps');
    expect(goalEvents.map((event) => event.change)).toEqual(['not_met', 'not_met', 'limit']);
    expect(goalEvents[2]).toMatchObject({
      condition: 'all tests pass',
      continuation: 2,
      maxContinuations: 2,
      reason: 'the tests were not run',
    });
    expect(agent.session.goal).toEqual({ condition: 'all tests pass' });
  });

  it('counts from zero again in the next run', async () => {
    const { agent, turns } = agentWith([notMet, notMet, met, notMet, met]);
    agent.setGoal('all tests pass');
    (agent as unknown as { opts: AgentOptions }).opts.goalCheck!.maxContinuations = 2;

    const first = await run(agent);
    agent.setGoal('the build is green');
    const second = await run(agent, 'now the build');

    expect(first.reason).toBe('stop');
    expect(second.goalEvents.map((event) => event.continuation)).toEqual([1, undefined]);
    expect(second.reason).toBe('stop');
    expect(turns.turns).toBe(5);
  });
});

describe('other answers of the goal checker', () => {
  it('ends the run and removes the goal when the goal is not possible', async () => {
    const { agent, turns } = agentWith([
      '{"result": "impossible", "reason": "the registry needs a token the agent does not have"}',
    ]);
    agent.setGoal('publish the package');

    const { reason, goalEvents } = await run(agent);

    expect(reason).toBe('stop');
    expect(turns.turns).toBe(1);
    expect(agent.session.goal).toBeUndefined();
    expect(goalEvents).toEqual([
      {
        type: 'goal_updated',
        condition: null,
        change: 'impossible',
        reason: 'the registry needs a token the agent does not have',
      },
    ]);
  });

  it('ends the run and keeps the goal when the check fails or says nothing it can read', async () => {
    const failing = agentWith([new Error('503 overloaded')]);
    const unreadable = agentWith(['The goal looks done to me.']);
    failing.agent.setGoal('all tests pass');
    unreadable.agent.setGoal('all tests pass');

    const failed = await run(failing.agent);
    const unread = await run(unreadable.agent);

    expect(failed.reason).toBe('stop');
    expect(failing.turns.turns).toBe(1);
    expect(failed.goalEvents).toEqual([
      {
        type: 'goal_updated',
        condition: 'all tests pass',
        change: 'unchecked',
        reason: 'the checker failed: 503 overloaded',
      },
    ]);
    expect(unread.goalEvents[0]).toMatchObject({ change: 'unchecked' });
    expect(unread.goalEvents[0]!.reason).toMatch(/no answer/);
    expect(failing.agent.session.goal).toEqual({ condition: 'all tests pass' });
  });

  it('ends the run when the checker does not answer in time', async () => {
    const { agent } = agentWith([met], {
      goalCheck: { ask: () => new Promise<string>(() => {}), timeoutMs: 20 },
    });
    agent.setGoal('all tests pass');

    const { reason, goalEvents } = await run(agent);

    expect(reason).toBe('stop');
    expect(goalEvents[0]).toMatchObject({ change: 'unchecked' });
    expect(goalEvents[0]!.reason).toMatch(/did not answer/);
  });

  it('ends the run as interrupted when the user stops it during the check', async () => {
    const { agent } = agentWith([met], {
      goalCheck: {
        ask: () =>
          new Promise<string>(() => {
            setTimeout(() => agent.interrupt(), 10);
          }),
      },
    });
    agent.setGoal('all tests pass');

    const { reason, goalEvents } = await run(agent);

    expect(reason).toBe('interrupted');
    expect(goalEvents).toHaveLength(0);
    expect(agent.session.goal).toEqual({ condition: 'all tests pass' });
  });
});

describe('the goal check and the Stop hook', () => {
  it('lets the Stop hook of the user speak first, and checks the goal when the hook lets the run end', async () => {
    const order: string[] = [];
    let fired = 0;
    const lifecycle = new LifecycleSource();
    lifecycle.subscribe(async (event) => {
      if (event.type !== 'Stop') return;
      fired += 1;
      order.push(`hook ${fired}`);
      return fired === 1 ? { blocked: true, reason: 'lint failed' } : { blocked: false };
    });
    const { agent, turns } = agentWith([met], {
      lifecycle,
      goalCheck: {
        ask: async () => {
          order.push('goal check');
          return met;
        },
      },
    });
    agent.setGoal('all tests pass');

    const { reason, goalEvents } = await run(agent);

    expect(order).toEqual(['hook 1', 'hook 2', 'goal check']);
    expect(turns.turns).toBe(2);
    expect(goalEvents.map((event) => event.change)).toEqual(['met']);
    expect(reason).toBe('stop');
  });
});
