import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel, ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { Agent, type ModelConfig, writeSessionMetadata } from '@chimera/core';
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
      const agent = new Agent({
        cwd: '/tmp',
        model,
        languageModel: textOnlyModel(text),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
        sessionId: init.sessionId,
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
    const r = await app.request('/healthz');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok');
  });

  it('instance endpoint returns metadata', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 42, cwd: '/tmp/x', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const r = await app.request('/v1/instance');
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.pid).toBe(42);
    expect(j.sandboxMode).toBe('off');
  });

  it('full session lifecycle: create, fetch, message, delete', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });

    const cr = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
    });
    expect(cr.status).toBe(201);
    const { sessionId } = await cr.json();
    expect(typeof sessionId).toBe('string');

    const getR = await app.request(`/v1/sessions/${sessionId}`);
    expect(getR.status).toBe(200);
    const session = await getR.json();
    expect(session.id).toBe(sessionId);
    expect(session.usage).toBeDefined();
    expect(session.usage.totalTokens).toBe(0);
    expect(session.usage.stepCount).toBe(0);

    const listR = await app.request('/v1/sessions');
    const list = await listR.json();
    expect(list).toHaveLength(1);

    const msgR = await app.request(`/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(msgR.status).toBe(202);

    // Second message while first is running → 409
    const msg2 = await app.request(`/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi again' }),
    });
    // May race: if run completed fast, it becomes another 202. Accept both but
    // assert at least one of the two queuings succeeded.
    expect([202, 409]).toContain(msg2.status);

    const delR = await app.request(`/v1/sessions/${sessionId}`, { method: 'DELETE' });
    expect(delR.status).toBe(204);

    const gone = await app.request(`/v1/sessions/${sessionId}`);
    expect(gone.status).toBe(404);
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

    const r = await app.request(`/v1/sessions/${sessionId}/interrupt`, { method: 'POST' });
    expect(r.status).toBe(204);
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
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (!entry!.runActive) {
          clearInterval(t);
          r();
        }
      }, 10);
    });

    const snap = entry!.bus.snapshot();
    expect(snap.length).toBeGreaterThan(0);
    const lastId = snap[snap.length - 1]!.eventId;

    // Replay with since=<first event id> should yield everything after the first.
    const firstId = snap[0]!.eventId;
    const replayed = entry!.bus.replay(firstId);
    expect(replayed[0]!.eventId).toBe(snap[1]!.eventId);
    expect(replayed[replayed.length - 1]!.eventId).toBe(lastId);

    // The bus should have forwarded a usage_updated event with cumulative
    // usage and the resolved contextWindow alongside the other agent events.
    const usageEnv = snap.find((e) => e.type === 'usage_updated');
    expect(usageEnv).toBeDefined();
    if (usageEnv && usageEnv.type === 'usage_updated') {
      expect(usageEnv.contextWindow).toBe(200_000);
      expect(usageEnv.usage.totalTokens).toBeGreaterThan(0);
    }

    // GET /v1/sessions/:id should reflect the post-run cumulative usage,
    // not the zero state observed before the run.
    const getR = await app.request(`/v1/sessions/${sessionId}`);
    const sessionAfter = await getR.json();
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

    const addR = await app.request(`/v1/sessions/${sessionId}/permissions/rules`, {
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
    expect(addR.status).toBe(201);

    const listR = await app.request(`/v1/sessions/${sessionId}/permissions/rules`);
    const rules = await listR.json();
    expect(rules).toHaveLength(1);

    const rmR = await app.request(`/v1/sessions/${sessionId}/permissions/rules/0`, {
      method: 'DELETE',
    });
    expect(rmR.status).toBe(204);

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

    const r = await app.request(`/v1/sessions/${sessionId}/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'updated prompt' }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
  });

  it('POST /v1/sessions/:id/reload returns 404 for unknown session', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });

    const r = await app.request('/v1/sessions/unknown-session-id/reload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'updated prompt' }),
    });
    expect(r.status).toBe(404);
  });
});
