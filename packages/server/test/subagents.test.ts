import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel, ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { Agent, type ModelConfig } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry, type AgentFactory } from '../src/agent-registry';
import { buildApp } from '../src/app';

function quietModel(): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'ok' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

const model: ModelConfig = { providerId: 'mock', modelId: 'm', maxSteps: 10 };

function makeFactory(home: string): AgentFactory {
  return {
    build: async () => ({
      agent: new Agent({
        cwd: '/tmp',
        model,
        languageModel: quietModel(),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
      }),
    }),
  };
}

describe('GET /v1/sessions/:id/subagents', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-subagents-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns an empty array for sessions with no subagents', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry });

    const cr = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
    });
    const { sessionId } = await cr.json();

    const r = await app.request(`/v1/sessions/${sessionId}/subagents`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it('reflects subagent_spawned and subagent_finished events from the bus', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry });

    const cr = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
    });
    const { sessionId } = await cr.json();

    const entry = registry.get(sessionId)!;
    entry.bus.publish({
      type: 'subagent_spawned',
      subagentId: 'sa1',
      parentCallId: 'pc1',
      childSessionId: 'child-sess-1',
      url: 'http://127.0.0.1:9999',
      purpose: 'investigate logs',
    });

    let r = await app.request(`/v1/sessions/${sessionId}/subagents`);
    let body = await r.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      subagentId: 'sa1',
      sessionId: 'child-sess-1',
      url: 'http://127.0.0.1:9999',
      purpose: 'investigate logs',
      status: 'running',
    });

    entry.bus.publish({
      type: 'subagent_finished',
      subagentId: 'sa1',
      parentCallId: 'pc1',
      result: 'done',
      reason: 'stop',
    });

    r = await app.request(`/v1/sessions/${sessionId}/subagents`);
    body = await r.json();
    expect(body).toEqual([]);
  });

  it('returns 404 for unknown sessions', async () => {
    const registry = new AgentRegistry({
      factory: makeFactory(home),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry });
    const r = await app.request('/v1/sessions/no-such/subagents');
    expect(r.status).toBe(404);
  });
});
