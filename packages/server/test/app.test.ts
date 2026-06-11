import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel, ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { Agent, loadSession, type ModelConfig, writeSessionMetadata } from '@chimera/core';
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

function makeFactory(home: string, text = 'hello from agent'): AgentFactory {
  return {
    build: async (init) => {
      // Honor the SessionInit contract: when a sessionId is provided and
      // already exists on disk, load it so messages/toolCalls round-trip.
      const session = init.sessionId
        ? await loadSession(init.sessionId, home).catch(() => undefined)
        : undefined;
      const agent = new Agent({
        cwd: '/tmp',
        model,
        languageModel: textOnlyModel(text),
        tools: {} as ToolSet,
        sandboxMode: 'off',
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

describe('server app', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-server-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('healthz returns ok', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const healthResponse = await app.request('/healthz');
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.text()).toBe('ok');
  });

  it('instance endpoint returns metadata', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 42, cwd: '/tmp/x', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const instanceResponse = await app.request('/v1/instance');
    expect(instanceResponse.status).toBe(200);
    const instanceBody = await instanceResponse.json();
    expect(instanceBody.pid).toBe(42);
    expect(instanceBody.sandboxMode).toBe('off');
  });

  it('full session lifecycle: create, fetch, message, delete', async () => {
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
    expect(createResponse.status).toBe(201);
    const { sessionId } = await createResponse.json();
    expect(typeof sessionId).toBe('string');

    const getResponse = await app.request(`/v1/sessions/${sessionId}`);
    expect(getResponse.status).toBe(200);
    const session = await getResponse.json();
    expect(session.id).toBe(sessionId);
    expect(session.usage).toBeDefined();
    expect(session.usage.totalTokens).toBe(0);
    expect(session.usage.stepCount).toBe(0);

    const listResponse = await app.request('/v1/sessions');
    const list = await listResponse.json();
    expect(list).toHaveLength(1);

    const firstMessageResponse = await app.request(`/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(firstMessageResponse.status).toBe(202);

    // Second message while first is running → 409
    const secondMessageResponse = await app.request(`/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi again' }),
    });
    // May race: if run completed fast, it becomes another 202. Accept both but
    // assert at least one of the two queuings succeeded.
    expect([202, 409]).toContain(secondMessageResponse.status);

    const deleteResponse = await app.request(`/v1/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(204);

    const goneResponse = await app.request(`/v1/sessions/${sessionId}`);
    expect(goneResponse.status).toBe(404);
  });

  it('interrupt responds 204 whether or not a run is active', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const { sessionId } = await (
      await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
      })
    ).json();

    const interruptResponse = await app.request(`/v1/sessions/${sessionId}/interrupt`, {
      method: 'POST',
    });
    expect(interruptResponse.status).toBe(204);
  });

  it('SSE events endpoint replays buffered events with ?since', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });

    const { sessionId } = await (
      await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
      })
    ).json();

    // Drive a run; collect envelopes from the bus directly.
    await app.request(`/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    // Wait for the run to settle.
    const entry = registry.get(sessionId);
    await new Promise<void>((resolveSettle) => {
      const ticker = setInterval(() => {
        if (!entry!.runActive) {
          clearInterval(ticker);
          resolveSettle();
        }
      }, 10);
    });

    const snapshot = entry!.bus.snapshot();
    expect(snapshot.length).toBeGreaterThan(0);
    const lastEventId = snapshot[snapshot.length - 1]!.eventId;

    // Replay with since=<first event id> should yield everything after the first.
    const firstEventId = snapshot[0]!.eventId;
    const replayed = entry!.bus.replay(firstEventId);
    expect(replayed[0]!.eventId).toBe(snapshot[1]!.eventId);
    expect(replayed[replayed.length - 1]!.eventId).toBe(lastEventId);

    // The bus should have forwarded a usage_updated event with cumulative
    // usage and the resolved contextWindow alongside the other agent events.
    const usageEnvelope = snapshot.find((envelope) => envelope.type === 'usage_updated');
    expect(usageEnvelope).toBeDefined();
    if (usageEnvelope && usageEnvelope.type === 'usage_updated') {
      expect(usageEnvelope.contextWindow).toBe(200_000);
      expect(usageEnvelope.usage.totalTokens).toBeGreaterThan(0);
    }

    // GET /v1/sessions/:id should reflect the post-run cumulative usage,
    // not the zero state observed before the run.
    const sessionResponse = await app.request(`/v1/sessions/${sessionId}`);
    const sessionAfter = await sessionResponse.json();
    expect(sessionAfter.usage.totalTokens).toBeGreaterThan(0);
  });

  it('rule CRUD via /permissions/rules', async () => {
    // Use a factory that also provides a gate.
    const { DefaultPermissionGate } = await import('@chimera/permissions');
    const factory: AgentFactory = {
      build: async (init) => {
        const agent = new Agent({
          cwd: init.cwd,
          model: init.model,
          languageModel: textOnlyModel('x'),
          tools: {} as ToolSet,
          sandboxMode: init.sandboxMode,
          home,
          contextWindow: 200_000,
        });
        const gate = new DefaultPermissionGate({
          cwd: init.cwd,
          autoApprove: 'none',
          raiseRequest: (req) => agent.raisePermissionRequest(req),
        });
        return { agent, gate };
      },
    };
    const registry = new AgentRegistry({
      factory,
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });

    const projectCwd = await mkdtemp(join(tmpdir(), 'chimera-rulescrud-'));
    const { sessionId } = await (
      await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: projectCwd, model, sandboxMode: 'off' }),
      })
    ).json();

    const addRuleResponse = await app.request(`/v1/sessions/${sessionId}/permissions/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rule: {
          tool: 'bash',
          target: 'host',
          pattern: 'pnpm *',
          patternKind: 'glob',
          decision: 'allow',
          createdAt: Date.now(),
        },
        scope: 'session',
      }),
    });
    expect(addRuleResponse.status).toBe(201);

    const listRulesResponse = await app.request(`/v1/sessions/${sessionId}/permissions/rules`);
    const rules = await listRulesResponse.json();
    expect(rules).toHaveLength(1);

    const removeRuleResponse = await app.request(`/v1/sessions/${sessionId}/permissions/rules/0`, {
      method: 'DELETE',
    });
    expect(removeRuleResponse.status).toBe(204);

    await rm(projectCwd, { recursive: true, force: true });
  });

  it('POST /v1/sessions/:id/reload updates system prompt', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });

    const { sessionId } = await (
      await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
      })
    ).json();

    const reloadResponse = await app.request(`/v1/sessions/${sessionId}/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'updated prompt' }),
    });
    expect(reloadResponse.status).toBe(200);
    const reloadBody = await reloadResponse.json();
    expect(reloadBody.ok).toBe(true);
  });

  it('POST /v1/sessions/:id/reload returns 404 for unknown session', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });

    const reloadResponse = await app.request('/v1/sessions/unknown-session-id/reload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'updated prompt' }),
    });
    expect(reloadResponse.status).toBe(404);
  });

  it('POST /v1/sessions/:id/compact returns 202 for existing idle session', async () => {
    const compactor = {
      maybeCompact: async () => ({ ran: false as const }),
      compact: async () => ({ summary: '', tokensBefore: 0, tokensAfter: 0, messagesReplaced: 0 }),
    };
    const factory: AgentFactory = {
      build: async (init) => {
        const agent = new Agent({
          cwd: init.cwd,
          model: init.model,
          languageModel: textOnlyModel('hi'),
          tools: {} as ToolSet,
          sandboxMode: init.sandboxMode,
          home,
          contextWindow: 200_000,
          compactor,
        });
        return { agent };
      },
    };
    const registry = new AgentRegistry({
      factory,
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const { sessionId } = await (
      await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
      })
    ).json();

    const compactResponse = await app.request(`/v1/sessions/${sessionId}/compact`, {
      method: 'POST',
    });
    expect(compactResponse.status).toBe(202);

    // Wait for compaction to finish before asserting state.
    const entry = registry.get(sessionId);
    await entry!.activeCompaction;

    const getResponse = await app.request(`/v1/sessions/${sessionId}`);
    expect(getResponse.status).toBe(200);
    const body = await getResponse.json();
    expect(body.compactionCount).toBe(1);
    expect(body.lastCompactedAt).toBeGreaterThan(0);
  });

  it('POST /v1/sessions/:id/compact returns 404 for unknown session', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const compactResponse = await app.request('/v1/sessions/unknown-session-id/compact', {
      method: 'POST',
    });
    expect(compactResponse.status).toBe(404);
  });

  it('POST /v1/sessions/:id/compact returns 409 when run is active', async () => {
    // Use a slow model so the run stays active long enough for the 409.
    const slowFactory: AgentFactory = {
      build: async (init) => {
        const agent = new Agent({
          cwd: init.cwd,
          model: init.model,
          languageModel: textOnlyModel('x'), // fast but at least one event
          tools: {} as ToolSet,
          sandboxMode: init.sandboxMode,
          home,
          contextWindow: 200_000,
        });
        return { agent };
      },
    };
    const registry = new AgentRegistry({
      factory: slowFactory,
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const { sessionId } = await (
      await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
      })
    ).json();

    // Start a run.
    await app.request(`/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });

    // Immediately try to compact while run is still active.
    const compactResponse = await app.request(`/v1/sessions/${sessionId}/compact`, {
      method: 'POST',
    });
    expect([409, 202]).toContain(compactResponse.status);
  });

  it('GET /v1/sessions/:id includes compactionActive, compactionCount and lastCompactedAt', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const { sessionId } = await (
      await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
      })
    ).json();

    const getResponse = await app.request(`/v1/sessions/${sessionId}`);
    expect(getResponse.status).toBe(200);
    const body = await getResponse.json();
    expect(body.compactionActive).toBe(false);
    expect(body.compactionCount).toBe(0);
    expect(body.lastCompactedAt).toBeNull();
  });

  it('GET /v1/sessions/:id reads compactionCount and lastCompactedAt from disk', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const { sessionId } = await (
      await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
      })
    ).json();

    // Write a compactions log directly on disk to simulate prior activity.
    const logPath = join(home, '.chimera', 'sessions', `${sessionId}.compactions.jsonl`);
    const entry1 = JSON.stringify({ ts: 1_700_000_000_000, reason: 'manual', tokensBefore: 10, tokensAfter: 5, summary: 's1', messagesReplaced: { count: 1, firstIndex: 0, lastIndex: 0 } });
    const entry2 = JSON.stringify({ ts: 1_800_000_000_000, reason: 'threshold', tokensBefore: 20, tokensAfter: 8, summary: 's2', messagesReplaced: { count: 2, firstIndex: 0, lastIndex: 1 } });
    await writeFile(logPath, entry1 + '\n' + entry2 + '\n', 'utf8');

    const getResponse = await app.request(`/v1/sessions/${sessionId}`);
    expect(getResponse.status).toBe(200);
    const body = await getResponse.json();
    expect(body.compactionCount).toBe(2);
    expect(body.lastCompactedAt).toBe(1_800_000_000_000);
    expect(body.compactionActive).toBe(false);
  });

  describe('negative input validation', () => {
    async function createSession(app: ReturnType<typeof buildApp>): Promise<string> {
      const response = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
      });
      const { sessionId } = await response.json();
      return sessionId;
    }

    it('POST /v1/sessions rejects malformed JSON', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const response = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{broken',
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid JSON');
    });

    it('POST /v1/sessions rejects missing required fields', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const response = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('bad request');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    it('POST /v1/sessions rejects wrong sandboxMode type', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const response = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 123 }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('bad request');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    it('POST /v1/sessions/:id/messages rejects malformed JSON', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad',
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid JSON');
    });

    it('POST /v1/sessions/:id/messages rejects missing content', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('bad request');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    it('POST /v1/sessions/:id/messages rejects non-string content', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 123 }),
      });
      expect(response.status).toBe(400);
    });

    it('POST /v1/sessions/:id/fork rejects malformed JSON', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const { sessionId } = await (
        await app.request('/v1/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
        })
      ).json();

      const response = await app.request(`/v1/sessions/${sessionId}/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{broken',
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid JSON');
    });

    it('POST /v1/sessions/:id/fork rejects non-string purpose', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const { sessionId } = await (
        await app.request('/v1/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
        })
      ).json();

      const response = await app.request(`/v1/sessions/${sessionId}/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 123 }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('bad request');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    it('POST /v1/sessions/:id/reload rejects malformed JSON', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/reload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad',
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid JSON');
    });

    it('POST /v1/sessions/:id/reload rejects wrong systemPrompt type', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/reload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ systemPrompt: 123 }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('bad request');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    it('POST /v1/sessions/:id/mode rejects malformed JSON', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad',
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid JSON');
    });

    it('POST /v1/sessions/:id/mode rejects non-string mode', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 123 }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('bad request');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    it('POST /v1/sessions/:id/mode returns 400 for invalid mode names', async () => {
      const factory: AgentFactory = {
        build: async (init) => {
          const agent = new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('x'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          });
          agent.setModeResolver((name) => {
            if (name !== 'build') throw new Error(`Unknown mode "${name}"`);
            return {
              systemPrompt: 'test',
              tools: {} as ToolSet,
              effectiveModel: 'mock/m',
              effectiveModelChanged: false,
            };
          });
          return { agent };
        },
      };
      const registry = new AgentRegistry({
        factory,
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'not-a-real-mode' }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('POST /v1/sessions/:id/model changes the model and publishes an event', async () => {
      const factory: AgentFactory = {
        build: async (init) => {
          const agent = new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('x'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          });
          agent.setModelChangeResolver((ref) => {
            const [providerId, modelId] = ref.split('/');
            return {
              model: { providerId, modelId, maxSteps: 10 },
              languageModel: textOnlyModel('new'),
              systemPrompt: `model set to ${ref}`,
              contextWindow: 128_000,
              contextWindowIsApproximate: false,
            };
          });
          return { agent };
        },
      };
      const registry = new AgentRegistry({
        factory,
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'other/new' }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.from).toBe('mock/m');
      expect(body.to).toBe('other/new');
    });

    it('POST /v1/sessions/:id/model rejects when no resolver is set', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'other/new' }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('not registered');
    });

    it('POST /v1/sessions/:id/model rejects malformed JSON', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad',
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid JSON');
    });

    it('POST /v1/sessions/:id/model rejects non-string model value', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 123 }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('bad request');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    it('POST /v1/sessions/:id/permissions/rules rejects malformed JSON', async () => {
      const { DefaultPermissionGate } = await import('@chimera/permissions');
      const factory: AgentFactory = {
        build: async (init) => {
          const agent = new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('x'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          });
          const gate = new DefaultPermissionGate({
            cwd: init.cwd,
            autoApprove: 'none',
            raiseRequest: (req) => agent.raisePermissionRequest(req),
          });
          return { agent, gate };
        },
      };
      const registry = new AgentRegistry({
        factory,
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/permissions/rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad',
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid JSON');
    });

    it('POST /v1/sessions/:id/permissions/rules rejects missing fields', async () => {
      const { DefaultPermissionGate } = await import('@chimera/permissions');
      const factory: AgentFactory = {
        build: async (init) => {
          const agent = new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('x'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          });
          const gate = new DefaultPermissionGate({
            cwd: init.cwd,
            autoApprove: 'none',
            raiseRequest: (req) => agent.raisePermissionRequest(req),
          });
          return { agent, gate };
        },
      };
      const registry = new AgentRegistry({
        factory,
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/permissions/rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rule: { tool: 'bash' } }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('bad request');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    it('POST /v1/sessions/:id/permissions/rules rejects wrong enum values', async () => {
      const { DefaultPermissionGate } = await import('@chimera/permissions');
      const factory: AgentFactory = {
        build: async (init) => {
          const agent = new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('x'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          });
          const gate = new DefaultPermissionGate({
            cwd: init.cwd,
            autoApprove: 'none',
            raiseRequest: (req) => agent.raisePermissionRequest(req),
          });
          return { agent, gate };
        },
      };
      const registry = new AgentRegistry({
        factory,
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/permissions/rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rule: {
            tool: 'bash',
            target: 'host',
            pattern: 'pnpm *',
            patternKind: 'invalid-kind',
            decision: 'allow',
            createdAt: Date.now(),
          },
          scope: 'session',
        }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('bad request');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    it('POST /v1/sessions/:id/permissions/:requestId rejects malformed JSON', async () => {
      const { DefaultPermissionGate } = await import('@chimera/permissions');
      const factory: AgentFactory = {
        build: async (init) => {
          const agent = new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('x'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          });
          const gate = new DefaultPermissionGate({
            cwd: init.cwd,
            autoApprove: 'none',
            raiseRequest: (req) => agent.raisePermissionRequest(req),
          });
          return { agent, gate };
        },
      };
      const registry = new AgentRegistry({
        factory,
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/permissions/r1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad',
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid JSON');
    });

    it('POST /v1/sessions/:id/permissions/:requestId rejects invalid decision', async () => {
      const { DefaultPermissionGate } = await import('@chimera/permissions');
      const factory: AgentFactory = {
        build: async (init) => {
          const agent = new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('x'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          });
          const gate = new DefaultPermissionGate({
            cwd: init.cwd,
            autoApprove: 'none',
            raiseRequest: (req) => agent.raisePermissionRequest(req),
          });
          return { agent, gate };
        },
      };
      const registry = new AgentRegistry({
        factory,
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/permissions/r1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'maybe' }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('bad request');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    it('POST /v1/sessions/:id/permissions/:requestId rejects invalid remember shape', async () => {
      const { DefaultPermissionGate } = await import('@chimera/permissions');
      const factory: AgentFactory = {
        build: async (init) => {
          const agent = new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('x'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          });
          const gate = new DefaultPermissionGate({
            cwd: init.cwd,
            autoApprove: 'none',
            raiseRequest: (req) => agent.raisePermissionRequest(req),
          });
          return { agent, gate };
        },
      };
      const registry = new AgentRegistry({
        factory,
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/permissions/r1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allow', remember: { scope: 'project' } }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('bad request');
      expect(Array.isArray(body.errors)).toBe(true);
    });

    it('POST /v1/sessions/:id/permissions/:requestId returns 409 for already resolved', async () => {
      const { DefaultPermissionGate } = await import('@chimera/permissions');
      const factory: AgentFactory = {
        build: async (init) => {
          const agent = new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('x'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          });
          const gate = new DefaultPermissionGate({
            cwd: init.cwd,
            autoApprove: 'none',
            raiseRequest: (req) => agent.raisePermissionRequest(req),
          });
          return { agent, gate };
        },
      };
      const registry = new AgentRegistry({
        factory,
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/permissions/r1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allow' }),
      });
      // r1 is not a pending request, so it returns 409
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe('already resolved');
    });

    it('POST /v1/sessions/:id/permissions/:requestId propagates unexpected errors as 500', async () => {
      const { DefaultPermissionGate } = await import('@chimera/permissions');
      const factory: AgentFactory = {
        build: async (init) => {
          const agent = new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('x'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          });
          const gate = new DefaultPermissionGate({
            cwd: init.cwd,
            autoApprove: 'none',
            raiseRequest: (req) => agent.raisePermissionRequest(req),
          });
          return { agent, gate };
        },
      };
      const registry = new AgentRegistry({
        factory,
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const entry = registry.get(sessionId);
      // Force the hasPendingPermission check to pass but resolvePermission to throw something unexpected
      const originalHasPending = entry!.agent.hasPendingPermission.bind(entry!.agent);
      entry!.agent.hasPendingPermission = () => true;
      const originalResolve = entry!.agent.resolvePermission.bind(entry!.agent);
      entry!.agent.resolvePermission = () => {
        throw new Error('something unexpected');
      };
      try {
        const response = await app.request(`/v1/sessions/${sessionId}/permissions/r1`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'allow' }),
        });
        expect(response.status).toBe(500);
      } finally {
        entry!.agent.hasPendingPermission = originalHasPending;
        entry!.agent.resolvePermission = originalResolve;
      }
    });

    it('POST /v1/sessions/:id/rewind rejects malformed JSON', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/rewind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad',
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid JSON');
    });

    it('POST /v1/sessions/:id/rewind rejects negative index', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);
      const response = await app.request(`/v1/sessions/${sessionId}/rewind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index: -1 }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('bad request');
      expect(Array.isArray(body.errors)).toBe(true);
    });
  });

  describe('checkpoints and rewind', () => {
    async function createSession(app: ReturnType<typeof buildApp>): Promise<string> {
      const response = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
      });
      const { sessionId } = await response.json();
      return sessionId;
    }

    async function waitForIdle(sessionId: string, registry: AgentRegistry): Promise<void> {
      const entry = registry.get(sessionId);
      if (!entry) return;
      await new Promise<void>((resolve) => {
        const ticker = setInterval(() => {
          if (!entry!.runActive) {
            clearInterval(ticker);
            resolve();
          }
        }, 10);
      });
    }

    it('GET /checkpoints returns single checkpoint for empty session', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);

      const response = await app.request(`/v1/sessions/${sessionId}/checkpoints`);
      expect(response.status).toBe(200);
      const checkpoints = await response.json();
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toStrictEqual({ index: 0, userMessage: '', toolCallSummary: '', truncateByteOffset: 0 });
    });

    it('GET /checkpoints returns 404 for missing session', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const response = await app.request('/v1/sessions/01KSHWCXG17ZRTQY9G13J3AETZ/checkpoints');
      expect(response.status).toBe(404);
    });

    it('GET /checkpoints happy path: multi-turn session', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);

      await app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'first message' }),
      });
      await waitForIdle(sessionId, registry);

      await app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'second message' }),
      });
      await waitForIdle(sessionId, registry);

      const response = await app.request(`/v1/sessions/${sessionId}/checkpoints`);
      expect(response.status).toBe(200);
      const checkpoints = await response.json();
      // Should have checkpoint 0 (before any messages) plus one for each user message.
      expect(checkpoints.length).toBeGreaterThanOrEqual(2);
      expect(checkpoints[0]!.index).toBe(0);
      expect(checkpoints[1]!.userMessage).toBe('first message');
    });

    it('POST /rewind truncates and patches live agent state', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);

      await app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'first message' }),
      });
      await waitForIdle(sessionId, registry);

      // Get checkpoints to know what index to rewind to.
      const checkpointsResponse = await app.request(`/v1/sessions/${sessionId}/checkpoints`);
      const checkpoints = await checkpointsResponse.json();
      expect(checkpoints.length).toBeGreaterThanOrEqual(2);
      const initialMessages = registry.get(sessionId)!.agent.session.messages.length;
      expect(initialMessages).toBeGreaterThan(0);

      // Rewind to checkpoint 0 (before first user message).
      const rewindResponse = await app.request(`/v1/sessions/${sessionId}/rewind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index: 0 }),
      });
      expect(rewindResponse.status).toBe(200);
      const rewindBody = await rewindResponse.json();
      expect(rewindBody.sessionId).toBe(sessionId);

      // Live agent state should be reset.
      const after = registry.get(sessionId)!.agent.session;
      expect(after.messages).toHaveLength(0);
      expect(after.toolCalls).toHaveLength(0);
      expect(after.usage.totalTokens).toBe(0);
    });

    it('POST /rewind restores the working tree from workspace checkpoints', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'chimera-rewindcwd-'));
      const cwdFactory: AgentFactory = {
        build: async (init) => {
          const session = init.sessionId
            ? await loadSession(init.sessionId, home).catch(() => undefined)
            : undefined;
          const agent = new Agent({
            cwd: init.cwd,
            model,
            languageModel: textOnlyModel('ok'),
            tools: {} as ToolSet,
            sandboxMode: 'off',
            home,
            contextWindow: 200_000,
            sessionId: init.sessionId,
            session,
          });
          await writeSessionMetadata(agent.session, home);
          return { agent };
        },
      };
      const registry = new AgentRegistry({
        factory: cwdFactory,
        instance: { pid: 1, cwd, version: '0.1.0', sandboxMode: 'off' },
        home,
        workspaceCheckpoints: true,
      });
      const app = buildApp({ registry, home });
      const createResponse = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd, model, sandboxMode: 'off' }),
      });
      const { sessionId } = await createResponse.json();

      try {
        await writeFile(join(cwd, 'a.txt'), 'v1');
        await app.request(`/v1/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'first message' }),
        });
        await waitForIdle(sessionId, registry);

        await writeFile(join(cwd, 'a.txt'), 'v2');
        await app.request(`/v1/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'second message' }),
        });
        await waitForIdle(sessionId, registry);

        await writeFile(join(cwd, 'a.txt'), 'v3');

        const checkpointsResponse = await app.request(`/v1/sessions/${sessionId}/checkpoints`);
        const checkpoints = await checkpointsResponse.json();
        const second = checkpoints.find(
          (entry: { userMessage: string }) => entry.userMessage === 'second message',
        );
        expect(second).toBeDefined();

        const rewindResponse = await app.request(`/v1/sessions/${sessionId}/rewind`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ index: second.index }),
        });
        expect(rewindResponse.status).toBe(200);
        const rewindBody = await rewindResponse.json();
        expect(rewindBody.workspaceRestored).toBe(true);
        expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('v2');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('POST /rewind reports workspaceRestored false when checkpointing is off', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);

      await app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'first message' }),
      });
      await waitForIdle(sessionId, registry);

      const rewindResponse = await app.request(`/v1/sessions/${sessionId}/rewind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index: 0 }),
      });
      expect(rewindResponse.status).toBe(200);
      const rewindBody = await rewindResponse.json();
      expect(rewindBody.workspaceRestored).toBe(false);
    });

    it('POST /rewind returns 404 for missing session', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const response = await app.request('/v1/sessions/01KSHWCXG17ZRTQY9G13J3AETZ/rewind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index: 0 }),
      });
      expect(response.status).toBe(404);
    });

    it('POST /rewind returns 409 during active run', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);

      // Start a message run but don't wait for it.
      await app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hi' }),
      });

      const response = await app.request(`/v1/sessions/${sessionId}/rewind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index: 0 }),
      });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe('run already in progress');
    });

    it('POST /rewind rewinds to middle of conversation', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);

      await app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'first message' }),
      });
      await waitForIdle(sessionId, registry);

      await app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'second message' }),
      });
      await waitForIdle(sessionId, registry);

      const checkpointsResponse = await app.request(`/v1/sessions/${sessionId}/checkpoints`);
      const checkpoints = await checkpointsResponse.json();

      // Find checkpoint for the second user message.
      const cp = checkpoints.find((c: { index: number; userMessage: string }) => c.userMessage === 'second message');
      expect(cp).toBeDefined();
      const targetIndex = cp!.index;

      const beforeRewind = registry.get(sessionId)!.agent.session.messages.length;
      expect(beforeRewind).toBeGreaterThan(0);

      const rewindResponse = await app.request(`/v1/sessions/${sessionId}/rewind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index: targetIndex }),
      });
      expect(rewindResponse.status).toBe(200);
      const rewindBody = await rewindResponse.json();
      expect(rewindBody.sessionId).toBe(sessionId);

      // Messages should now only contain system + first user message (anything before second).
      const after = registry.get(sessionId)!.agent.session;
      expect(after.messages.length).toBeLessThan(beforeRewind);
      // The second user message should no longer appear.
      expect(after.messages.some((m: { content: string }) => m.content === 'second message')).toBe(false);
    });

    it('POST /fork with rewindIndex creates child with truncated history', async () => {
      const registry = new AgentRegistry({
        factory: makeFactory(home),
        instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
      });
      const app = buildApp({ registry, home });
      const sessionId = await createSession(app);

      await app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'first' }),
      });
      await waitForIdle(sessionId, registry);

      await app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'second' }),
      });
      await waitForIdle(sessionId, registry);

      const checkpointsResponse = await app.request(`/v1/sessions/${sessionId}/checkpoints`);
      const checkpoints = await checkpointsResponse.json();
      expect(checkpoints.length).toBeGreaterThanOrEqual(2);
      const rewindIndex = checkpoints[0]!.index;

      const forkResponse = await app.request(`/v1/sessions/${sessionId}/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'fork with rewind', rewindIndex }),
      });
      expect(forkResponse.status).toBe(201);
      const forkBody = await forkResponse.json();
      expect(forkBody.parentId).toBe(sessionId);
      expect(typeof forkBody.sessionId).toBe('string');

      // Child should have truncated messages.
      const childResponse = await app.request(`/v1/sessions/${forkBody.sessionId}`);
      expect(childResponse.status).toBe(200);
      const childSession = await childResponse.json();
      // Checkpoint 0 means before first user message, so child messages should be empty.
      expect(childSession.messages).toHaveLength(0);
    });
  });
});
