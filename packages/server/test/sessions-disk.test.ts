import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel, ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import {
  Agent,
  loadSession,
  type ModelConfig,
  persistSession,
  sessionEventsPath,
  writeSessionMetadata,
} from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry, type AgentFactory } from '../src/agent-registry';
import { buildApp } from '../src/app';

function textOnlyModel(text: string): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: text },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

const model: ModelConfig = { providerId: 'mock', modelId: 'm', maxSteps: 10 };

function makeFactory(home: string, text = 'reply'): AgentFactory {
  return {
    build: async (init) => {
      // Honor the SessionInit contract: when a sessionId is provided and
      // already exists on disk, load it so messages/toolCalls are restored.
      const session = init.sessionId
        ? await loadSession(init.sessionId, home).catch(() => undefined)
        : undefined;
      const agent = new Agent({
        cwd: init.cwd,
        model: init.model,
        languageModel: textOnlyModel(text),
        tools: {} as ToolSet,
        sandboxMode: init.sandboxMode,
        home,
        contextWindow: 200_000,
        sessionId: init.sessionId,
        session,
      });
      await writeSessionMetadata(agent.session, home);
      return { agent };
    },
  };
}

describe('disk-aware session routes', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-disk-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('GET /v1/sessions returns disk-scanned results', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    // Create two sessions; both should appear after creation.
    const firstCreateResponse = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
    });
    const firstSession = (await firstCreateResponse.json()) as {
      sessionId: string;
    };
    const secondCreateResponse = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
    });
    const secondSession = (await secondCreateResponse.json()) as {
      sessionId: string;
    };

    const list = (await (
      await app.request('/v1/sessions')
    ).json()) as Array<{
      id: string;
    }>;
    const persistedIds = list.map((entry) => entry.id).sort();
    expect(persistedIds).toEqual(
      [firstSession.sessionId, secondSession.sessionId].sort(),
    );
  });

  it('cache invalidates on create / fork / delete', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const initialList = (await (
      await app.request('/v1/sessions')
    ).json()) as Array<unknown>;
    expect(initialList).toHaveLength(0);

    const createResponse = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
    });
    const { sessionId } = (await createResponse.json()) as { sessionId: string };

    const listAfterCreate = (await (
      await app.request('/v1/sessions')
    ).json()) as Array<unknown>;
    expect(listAfterCreate).toHaveLength(1);

    const forkResponse = await app.request(`/v1/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(forkResponse.status).toBe(201);
    const listAfterFork = (await (
      await app.request('/v1/sessions')
    ).json()) as Array<unknown>;
    expect(listAfterFork).toHaveLength(2);
  });

  it('POST /v1/sessions/:id/resume loads a persisted session with its messages', async () => {
    // Create a session, persist a step_finished snapshot with messages,
    // then resume against a fresh registry to confirm the messages
    // round-trip through the resume route.
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const createResponse = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
    });
    const { sessionId } = (await createResponse.json()) as {
      sessionId: string;
    };

    // Inject a step_finished snapshot directly so the persisted session
    // has known messages, independent of any model run.
    const persistedSession = await loadSession(sessionId, home);
    const expectedMessages = [
      { role: 'user' as const, content: 'first message' },
      { role: 'assistant' as const, content: 'first reply' },
    ];
    persistedSession.messages = expectedMessages;
    await persistSession(
      persistedSession,
      {
        type: 'step_finished',
        stepNumber: 1,
        finishReason: 'stop',
        messages: expectedMessages,
        toolCalls: [],
        usage: persistedSession.usage,
      },
      home,
    );

    // Spin up a fresh registry/app pointing at the same home — simulates
    // a server restart.
    const freshRegistry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const freshApp = buildApp({ registry: freshRegistry, home });
    expect(freshRegistry.get(sessionId)).toBeNull();

    const resumeResponse = await freshApp.request(
      `/v1/sessions/${sessionId}/resume`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(resumeResponse.status).toBe(200);
    const resumeBody = (await resumeResponse.json()) as { sessionId: string };
    expect(resumeBody.sessionId).toBe(sessionId);
    expect(freshRegistry.get(sessionId)).not.toBeNull();

    // The resumed agent's session must carry the persisted messages.
    const sessionResponse = await freshApp.request(`/v1/sessions/${sessionId}`);
    expect(sessionResponse.status).toBe(200);
    const restoredSession = (await sessionResponse.json()) as {
      messages: unknown[];
    };
    expect(restoredSession.messages).toEqual(expectedMessages);
  });

  it('POST /v1/sessions/:id/fork creates an isolated child', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const parentCreateResponse = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
    });
    const { sessionId: parentId } = (await parentCreateResponse.json()) as {
      sessionId: string;
    };

    const forkResponse = await app.request(`/v1/sessions/${parentId}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'try alt' }),
    });
    expect(forkResponse.status).toBe(201);
    const { sessionId: childId, parentId: returnedParentId } =
      (await forkResponse.json()) as { sessionId: string; parentId: string };
    expect(returnedParentId).toBe(parentId);
    expect(childId).not.toBe(parentId);

    // Child's events.jsonl should contain a forked_from line.
    const childEvents = await readFile(sessionEventsPath(childId, home), 'utf8');
    expect(childEvents).toContain('"type":"forked_from"');
    expect(childEvents).toContain('"purpose":"try alt"');
  });

  it('DELETE rejects with 409 when the session has children', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const createResponse = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
    });
    const { sessionId: parentId } = (await createResponse.json()) as {
      sessionId: string;
    };
    await app.request(`/v1/sessions/${parentId}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    const deleteResponse = await app.request(`/v1/sessions/${parentId}`, {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(409);
    const errorBody = (await deleteResponse.json()) as {
      error: string;
      children: string[];
    };
    expect(errorBody.error).toMatch(/children/);
    expect(errorBody.children).toHaveLength(1);
  });

  it('resume of an unknown session returns 404', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    // Use a syntactically valid ULID (26 chars Crockford base32) that's never been created
    const resumeResponse = await app.request(
      '/v1/sessions/01HZZZZZZZZZZZZZZZZZZZZZZZ/resume',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(resumeResponse.status).toBe(404);
  });

  it('fork onFork hook fires for overlay-mode parents', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'overlay' },
    });
    let onForkCalled:
      | { parentId: string; childId: string; mode: string }
      | null = null;
    const app = buildApp({
      registry,
      home,
      onFork: async (parent, childId) => {
        onForkCalled = {
          parentId: parent.id,
          childId,
          mode: parent.sandboxMode,
        };
      },
    });
    const createResponse = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'overlay' }),
    });
    const { sessionId: parentId } = (await createResponse.json()) as {
      sessionId: string;
    };

    const forkResponse = await app.request(`/v1/sessions/${parentId}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(forkResponse.status).toBe(201);
    expect(onForkCalled).not.toBeNull();
    expect(onForkCalled!.parentId).toBe(parentId);
    expect(onForkCalled!.mode).toBe('overlay');
  });

  it('DELETE waits for an in-flight run to settle before tearing down the dir', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home, 'reply text'),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const createResponse = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
    });
    const { sessionId } = (await createResponse.json()) as {
      sessionId: string;
    };

    // Kick off a run, then immediately DELETE.
    const sendResponse = await app.request(
      `/v1/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hi' }),
      },
    );
    expect(sendResponse.status).toBe(202);

    const deleteResponse = await app.request(`/v1/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(204);

    // Once DELETE returns, the run's persistSession must already have run
    // and the directory must already be gone — there's no way for a stray
    // appendFile to recreate it after this point.
    const { existsSync } = await import('node:fs');
    expect(
      existsSync(join(home, '.chimera', 'sessions', sessionId)),
    ).toBe(false);
  });
});
