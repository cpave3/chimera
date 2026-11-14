import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type LifecycleEvent, LifecycleSource } from '@chimera/core';
import { DefaultHookRunner, type FirePayload, type HookRunner } from '@chimera/hooks';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentRegistry, type SessionInit } from '../src/agent-registry';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'chimera-session-lifecycle-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(runner?: HookRunner, languageModel = new MockLanguageModelV3()) {
  const lifecycle = new LifecycleSource();
  const observed: LifecycleEvent[] = [];
  const scripts: FirePayload[] = [];
  lifecycle.subscribe((event) => {
    observed.push(event);
  });
  const registry = new AgentRegistry({
    factory: {
      build: async (init) => ({
        agent: new Agent({
          cwd: root,
          model: init.model,
          sessionId: init.sessionId ?? init.requestedSessionId,
          sessionName: init.name,
          languageModel,
          tools: {},
          sandboxMode: 'off',
          contextWindow: 200_000,
          home: root,
          lifecycle,
        }),
        hookRunner: runner ?? {
          fire: async (payload) => {
            scripts.push(payload);
            return { blocked: false };
          },
        },
      }),
    },
    instance: {
      pid: 1,
      cwd: root,
      version: 'test',
      sandboxMode: 'off',
      parentId: 'parent-session',
    },
  });
  const create = (options: Partial<SessionInit> = {}) =>
    registry.create({
      cwd: root,
      model: { providerId: 'mock', modelId: 'mock', maxSteps: 1 },
      sandboxMode: 'off',
      ...options,
    });
  return { registry, create, scripts, observed };
}

function gatedModel() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let interrupted = false;
  const languageModel = new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => {
      abortSignal!.addEventListener('abort', () => {
        interrupted = true;
      });
      started();
      await gate;
      return { stream: new ReadableStream({ start: (controller) => controller.close() }) };
    },
  });
  return { languageModel, ready, release, interrupted: () => interrupted };
}

it('emits SessionEnd within the shared shutdown budget even when an interrupted model hangs', async () => {
  const model = gatedModel();
  const { registry, create, observed, scripts } = setup(undefined, model.languageModel);
  const first = await create();
  const second = await create();
  await registry.run(first.sessionId, 'hang');
  await registry.run(second.sessionId, 'hang too');
  await model.ready;
  await expect.poll(() => model.languageModel.doStreamCalls.length).toBe(2);
  const runs = [first.entry.activeRun, second.entry.activeRun];
  try {
    const startedAt = Date.now();
    await registry.shutdown('signal', 150);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(model.interrupted()).toBe(true);
    expect(observed.filter((event) => event.type === 'SessionEnd')).toEqual([
      expect.objectContaining({ sessionId: first.sessionId, reason: 'signal' }),
      expect.objectContaining({ sessionId: second.sessionId, reason: 'signal' }),
    ]);
    expect(scripts.filter((payload) => payload.event === 'SessionEnd')).toHaveLength(2);
    await registry.shutdown('exit');
    expect(scripts.filter((payload) => payload.event === 'SessionEnd')).toHaveLength(2);
  } finally {
    model.release();
    await Promise.all(runs);
  }
});

it('starts new, resumed and forked sessions with metadata and preserves SessionCreated', async () => {
  const { create, scripts } = setup();
  const { sessionId } = await create({ name: 'fresh' });
  await create({ sessionId: 'resumed', name: 'resumed' });
  await create({ sessionId: 'forked', startReason: 'fork' });
  expect(scripts.filter((payload) => payload.event === 'SessionCreated')).toEqual([
    { event: 'SessionCreated', session_name: 'fresh' },
  ]);
  expect(scripts.filter((payload) => payload.event === 'SessionStart')).toEqual([
    {
      event: 'SessionStart',
      reason: 'new',
      session_name: 'fresh',
      parentSessionId: 'parent-session',
    },
    {
      event: 'SessionStart',
      reason: 'resume',
      session_name: 'resumed',
      parentSessionId: 'parent-session',
    },
    {
      event: 'SessionStart',
      reason: 'fork',
      session_name: undefined,
      parentSessionId: 'parent-session',
    },
  ]);
  expect(sessionId).toBeTruthy();
});

it('ends and reactivates a switched session once without deleting it', async () => {
  const { registry, create, observed } = setup();
  const { sessionId } = await create();
  expect(await registry.endSession(sessionId, 'switch')).toBe(true);
  expect(await registry.endSession(sessionId, 'switch')).toBe(false);
  expect(registry.get(sessionId)).not.toBeNull();
  expect(await registry.startSession(sessionId, 'switch')).toBe(true);
  expect(await registry.startSession(sessionId, 'switch')).toBe(false);
  await registry.delete(sessionId);
  expect(
    observed
      .filter((event) => event.type === 'SessionStart' || event.type === 'SessionEnd')
      .map((event) => [event.type, 'reason' in event ? event.reason : undefined]),
  ).toEqual([
    ['SessionStart', 'new'],
    ['SessionEnd', 'switch'],
    ['SessionStart', 'switch'],
    ['SessionEnd', 'delete'],
  ]);
});

it('interrupts and waits for the old run before ending it and starting the switched session', async () => {
  const model = gatedModel();
  const order: string[] = [];
  const { registry, create, observed } = setup(
    {
      fire: async (payload) => {
        if (payload.event === 'SessionEnd') order.push('old end');
        if (payload.event === 'SessionStart' && payload.reason === 'switch')
          order.push('new start');
        return { blocked: false };
      },
    },
    model.languageModel,
  );
  const { sessionId, entry } = await create();
  entry.bus.subscribe((event) => {
    if (event.type === 'run_finished') order.push('old run finished');
  });
  await registry.run(sessionId, 'wait for interruption');
  await model.ready;
  const transition = (async () => {
    await registry.endSession(sessionId, 'switch');
    return create({ startReason: 'switch' });
  })();
  try {
    await expect.poll(model.interrupted, { timeout: 200 }).toBe(true);
    expect(observed.filter((event) => event.type === 'SessionEnd')).toEqual([]);
    expect(order).toEqual([]);
  } finally {
    model.release();
    await transition;
  }
  expect(order).toEqual(['old run finished', 'old end', 'new start']);
  expect(registry.get(sessionId)).not.toBeNull();
});

it('fails a switch after a bounded wait without ending the still-running session', async () => {
  const model = gatedModel();
  const { registry, create, observed } = setup(undefined, model.languageModel);
  const { sessionId, entry } = await create();
  await registry.run(sessionId, 'hang');
  await model.ready;
  const run = entry.activeRun;
  vi.useFakeTimers();
  try {
    const transition = registry.endSession(sessionId, 'switch');
    const rejected = expect(transition).rejects.toThrow('timed out after 10000ms');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(model.interrupted()).toBe(true);
    expect(observed.filter((event) => event.type === 'SessionEnd')).toEqual([]);
  } finally {
    vi.useRealTimers();
    model.release();
    await run;
  }
  expect(await registry.endSession(sessionId, 'switch')).toBe(true);
});

it('shares the default two-second shutdown budget across hung runs and sleeping shell hooks', async () => {
  const marker = join(root, 'started');
  const directory = join(root, '.chimera', 'hooks', 'SessionEnd');
  await mkdir(directory, { recursive: true });
  const script = join(directory, 'sleep.sh');
  await writeFile(script, `#!/bin/sh\necho started > ${JSON.stringify(marker)}\nsleep 5\n`);
  await chmod(script, 0o755);
  const runner = new DefaultHookRunner({
    cwd: root,
    sessionId: 'session',
    globalRoot: join(root, 'none'),
    timeoutMs: 10_000,
    log: () => {},
  });
  const model = gatedModel();
  const { registry, create, observed } = setup(runner, model.languageModel);
  const first = await create();
  const second = await create();
  await registry.run(first.sessionId, 'hang');
  await registry.run(second.sessionId, 'hang too');
  await expect.poll(() => model.languageModel.doStreamCalls.length).toBe(2);
  const runs = [first.entry.activeRun, second.entry.activeRun];
  try {
    const startedAt = Date.now();
    await registry.shutdown('exit');
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(model.interrupted()).toBe(true);
    expect(await readFile(marker, 'utf8')).toBe('started\n');
    expect(
      observed
        .filter((event) => event.type === 'SessionEnd')
        .map((event) => 'reason' in event && event.reason),
    ).toEqual(['exit', 'exit']);
    await registry.shutdown('signal');
    expect(observed.filter((event) => event.type === 'SessionEnd')).toHaveLength(2);
  } finally {
    model.release();
    await Promise.all(runs);
  }
});

it('injects idle append context without a prompt hook or a new turn', async () => {
  const { registry, create, scripts, observed } = setup();
  const { sessionId, entry } = await create();
  expect(await registry.injectMessage(sessionId, '@file contents')).toBe('injected');
  await entry.agent.lifecycle.drain(sessionId);
  expect(observed.filter((event) => event.type === 'message_appended')).toEqual([
    {
      type: 'message_appended',
      text: '@file contents',
      imageCount: undefined,
      sessionId,
      cwd: root,
    },
  ]);
  expect(observed.filter((event) => event.type === 'user_message')).toEqual([]);
  expect(scripts.some((payload) => payload.event === 'UserPromptSubmit')).toBe(false);
  expect(entry.agent.session.messages.at(-1)).toMatchObject({
    role: 'user',
    content: '@file contents',
  });
});
