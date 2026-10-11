import { parseBackgroundAgentMessage } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { BackgroundAgents, buildBackgroundAgentTools } from '../src/background';
import type { DriveResult } from '../src/subagent-driver';

const ended = (over: Partial<DriveResult> = {}): DriveResult => ({
  finalText: 'found it',
  reason: 'stop',
  steps: 2,
  toolCallsCount: 3,
  ...over,
});

/** A child whose end the test decides. */
function child() {
  let finish: (result: DriveResult) => void = () => {};
  let signal: AbortSignal | undefined;
  const run = (given: AbortSignal) => {
    signal = given;
    return new Promise<DriveResult>((resolve) => {
      finish = resolve;
      given.addEventListener('abort', () =>
        resolve(ended({ finalText: '', reason: 'interrupted' })),
      );
    });
  };
  return { run, finish: (result: DriveResult) => finish(result), aborted: () => signal?.aborted };
}

function manager() {
  const delivered: string[] = [];
  let clock = 1_000;
  const agents = new BackgroundAgents({
    deliver: (message) => {
      delivered.push(message);
    },
    now: () => clock,
  });
  return { agents, delivered, advance: (ms: number) => (clock += ms) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('BackgroundAgents', () => {
  it('lists a child as running until it ends, then delivers its answer', async () => {
    const { agents, delivered, advance } = manager();
    const first = child();
    agents.start({ id: 'a1', purpose: 'map the auth flow', agent: 'explore' }, first.run);

    expect(agents.list()).toEqual([
      {
        id: 'a1',
        purpose: 'map the auth flow',
        agent: 'explore',
        state: 'running',
        startedAt: 1_000,
      },
    ]);
    expect(delivered).toEqual([]);

    advance(4_000);
    first.finish(ended());
    await settle();

    expect(agents.get('a1')).toMatchObject({ state: 'done', result: 'found it', endedAt: 5_000 });
    expect(delivered).toHaveLength(1);
    expect(parseBackgroundAgentMessage(delivered[0]!)).toEqual({
      id: 'a1',
      purpose: 'map the auth flow',
      state: 'done',
    });
    expect(delivered[0]).toContain('found it');
  });

  it('reports a child that failed, with what went wrong', async () => {
    const { agents, delivered } = manager();
    const failing = child();
    agents.start({ id: 'a1', purpose: 'run the audit' }, failing.run);

    failing.finish(ended({ finalText: '', reason: 'error', errorMessage: 'provider is down' }));
    await settle();

    expect(agents.get('a1')).toMatchObject({ state: 'failed', result: 'provider is down' });
    expect(parseBackgroundAgentMessage(delivered[0]!)?.state).toBe('failed');
    expect(delivered[0]).toContain('provider is down');
  });

  it('stops one child without a message, since the caller asked for it', async () => {
    const { agents, delivered } = manager();
    const first = child();
    const second = child();
    agents.start({ id: 'a1', purpose: 'one' }, first.run);
    agents.start({ id: 'a2', purpose: 'two' }, second.run);

    expect(await agents.stop('a1')).toBe(true);

    expect(first.aborted()).toBe(true);
    expect(second.aborted()).toBe(false);
    expect(agents.get('a1')?.state).toBe('stopped');
    expect(agents.runningCount()).toBe(1);
    expect(delivered).toEqual([]);
    expect(await agents.stop('nope')).toBe(false);
  });

  it('stops every running child when the session ends', async () => {
    const { agents, delivered } = manager();
    const first = child();
    const second = child();
    agents.start({ id: 'a1', purpose: 'one' }, first.run);
    agents.start({ id: 'a2', purpose: 'two' }, second.run);

    await agents.stopAll();

    expect(first.aborted()).toBe(true);
    expect(second.aborted()).toBe(true);
    expect(agents.runningCount()).toBe(0);
    expect(delivered).toEqual([]);
  });
});

describe('background agent tools', () => {
  type Tool = { execute: (args: unknown, options: unknown) => Promise<unknown> };
  const call = (tool: unknown, args: unknown) => (tool as Tool).execute(args, {});

  it('agent_status lists every child, and gives the answer of the one asked for', async () => {
    const { agents, advance } = manager();
    const first = child();
    const second = child();
    agents.start({ id: 'a1', purpose: 'one' }, first.run);
    agents.start({ id: 'a2', purpose: 'two' }, second.run);
    first.finish(ended({ finalText: 'answer one' }));
    await settle();
    advance(90_000);
    const tools = buildBackgroundAgentTools(agents);

    expect(await call(tools.agent_status.tool, {})).toEqual({
      agents: [
        { id: 'a1', purpose: 'one', state: 'done', seconds: 0 },
        { id: 'a2', purpose: 'two', state: 'running', seconds: 90 },
      ],
    });
    expect(await call(tools.agent_status.tool, { id: 'a1' })).toEqual({
      agents: [{ id: 'a1', purpose: 'one', state: 'done', seconds: 0, result: 'answer one' }],
    });
    expect(await call(tools.agent_status.tool, { id: 'zz' })).toEqual({
      agents: [],
      error: 'no background agent with id "zz"',
    });
  });

  it('agent_stop stops a running child and says so', async () => {
    const { agents } = manager();
    const first = child();
    agents.start({ id: 'a1', purpose: 'one' }, first.run);
    const tools = buildBackgroundAgentTools(agents);

    expect(await call(tools.agent_stop.tool, { id: 'a1' })).toEqual({ id: 'a1', state: 'stopped' });
    expect(await call(tools.agent_stop.tool, { id: 'a1' })).toEqual({
      id: 'a1',
      state: 'stopped',
      note: 'the agent had already ended',
    });
    expect(await call(tools.agent_stop.tool, { id: 'zz' })).toEqual({
      id: 'zz',
      error: 'no background agent with id "zz"',
    });
  });
});
