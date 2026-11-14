import type { AgentEvent, SessionId } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { BackgroundAgents } from '../src/background';
import { buildSpawnAgentTool } from '../src/spawn-tool';
import type { InProcessAgentBuilder, SpawnAgentToolContext } from '../src/types';

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** An in-process child that answers only when the test lets it. */
function gatedChild() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let interrupted = false;
  const builder: InProcessAgentBuilder = async () => ({
    sessionId: 'child-1' as SessionId,
    send: (_prompt, opts) =>
      (async function* (): AsyncGenerator<AgentEvent> {
        await Promise.race([
          gate,
          new Promise<void>((resolve) => opts?.signal?.addEventListener('abort', () => resolve())),
        ]);
        if (opts?.signal?.aborted) {
          yield { type: 'run_finished', reason: 'interrupted' };
          return;
        }
        yield { type: 'assistant_text_done', text: 'the answer' };
        yield { type: 'run_finished', reason: 'stop' };
      })(),
    interrupt: () => {
      interrupted = true;
    },
    dispose: async () => {},
  });
  return { builder, release: () => release(), wasInterrupted: () => interrupted };
}

function setup(over: Partial<SpawnAgentToolContext> = {}) {
  const events: AgentEvent[] = [];
  const delivered: string[] = [];
  const parent = new AbortController();
  const background = new BackgroundAgents({ deliver: (message) => void delivered.push(message) });
  const child = gatedChild();
  const ctx: SpawnAgentToolContext = {
    emit: (event) => events.push(event),
    parentAbortSignal: parent.signal,
    parentSessionId: 'parent-1',
    cwd: '/tmp',
    defaultModelRef: 'anthropic/claude-haiku-4-5',
    sandboxMode: 'off',
    autoApprove: 'host',
    currentDepth: 0,
    maxDepth: 3,
    chimeraBin: '/usr/bin/false',
    parentHasTty: true,
    inProcess: child.builder,
    background,
    ...over,
  };
  const tool = buildSpawnAgentTool(ctx).tool as unknown as {
    execute: (args: unknown, options: unknown) => Promise<Record<string, unknown>>;
  };
  const call = (args: Record<string, unknown>) =>
    tool.execute(
      { prompt: 'go', purpose: 'map the auth flow', in_process: true, ...args },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
  return { call, events, delivered, parent, background, child };
}

describe('spawn_agent in the background', () => {
  it('returns at once with the id of a child that is still running', async () => {
    const { call, events, background, delivered } = setup();

    const result = await call({ background: true });

    expect(result).toMatchObject({ status: 'running', session_id: 'child-1' });
    expect(result.note).toMatch(/agent_status/);
    expect(background.get(result.subagent_id as string)).toMatchObject({
      state: 'running',
      purpose: 'map the auth flow',
    });
    expect(events.map((event) => event.type)).toEqual(['subagent_spawned']);
    expect(events[0]).toMatchObject({ background: true });
    expect(delivered).toEqual([]);
  });

  it('delivers the answer to the parent when the child ends', async () => {
    const { call, events, background, delivered, child } = setup();
    const result = await call({ background: true });

    child.release();
    await settle();

    expect(background.get(result.subagent_id as string)).toMatchObject({
      state: 'done',
      result: 'the answer',
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('the answer');
    expect(events[0]).toMatchObject({ type: 'subagent_spawned', background: true });
    expect(events.at(-1)).toMatchObject({
      type: 'subagent_finished',
      reason: 'stop',
      background: true,
    });
  });

  it.each([
    false,
    true,
  ])('labels builder errors with the selected background mode (%s)', async (background) => {
    const { call, events } = setup({
      inProcess: async () => {
        throw new Error('builder failed');
      },
    });

    expect(await call({ background })).toMatchObject({ reason: 'error', result: 'builder failed' });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'subagent_finished',
        reason: 'error',
        result: 'builder failed',
        background,
      }),
    ]);
  });

  it('keeps the child running when the run that started it is interrupted', async () => {
    const { call, background, parent, child } = setup();
    const result = await call({ background: true });

    parent.abort();
    await settle();

    expect(child.wasInterrupted()).toBe(false);
    expect(background.get(result.subagent_id as string)?.state).toBe('running');
    await background.stopAll();
  });

  it('stops the child when the model asks for it', async () => {
    const { call, background, child, delivered } = setup();
    const result = await call({ background: true });

    await background.stop(result.subagent_id as string);

    expect(child.wasInterrupted()).toBe(true);
    expect(background.get(result.subagent_id as string)?.state).toBe('stopped');
    expect(delivered).toEqual([]);
  });

  it('runs in the foreground, and says so, where the session cannot wait for a child', async () => {
    const { call, child, events } = setup({ background: undefined });

    const pending = call({ background: true });
    await settle();
    child.release();
    const result = await pending;

    expect(result).toMatchObject({ result: 'the answer', reason: 'stop' });
    expect(result.status).toBeUndefined();
    expect(result.note).toMatch(/foreground/);
    expect(events[0]).toMatchObject({ type: 'subagent_spawned', background: false });
    expect(events.at(-1)).toMatchObject({ type: 'subagent_finished', background: false });
  });

  it('still blocks for a call that does not ask for the background', async () => {
    const { call, child, background } = setup();

    const pending = call({});
    await settle();
    expect(background.list()).toEqual([]);
    child.release();

    expect(await pending).toMatchObject({ result: 'the answer', reason: 'stop' });
  });
});
