import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type LifecycleEvent, LifecycleSource } from '@chimera/core';
import { DefaultHookRunner, type FirePayload, type HookRunner } from '@chimera/hooks';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AgentRegistry, type SessionInit } from '../src/agent-registry';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'chimera-session-lifecycle-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(runner?: HookRunner) {
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
          languageModel: new MockLanguageModelV3(),
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

it('shares one shutdown budget across sessions and terminates sleeping shell hooks', async () => {
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
  const { registry, create, observed } = setup(runner);
  await create();
  await create();
  const startedAt = Date.now();
  await registry.shutdown('signal', 150);
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(await readFile(marker, 'utf8')).toBe('started\n');
  expect(
    observed
      .filter((event) => event.type === 'SessionEnd')
      .map((event) => 'reason' in event && event.reason),
  ).toEqual(['signal', 'signal']);
  await registry.shutdown('exit');
  expect(observed.filter((event) => event.type === 'SessionEnd')).toHaveLength(2);
});
