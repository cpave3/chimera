import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel, ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { Agent, type ModelConfig, writeSessionMetadata } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentFactory } from '../src/agent-registry';
import { AgentRegistry } from '../src/agent-registry';
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

describe('session paths endpoints', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-server-paths-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  interface StubSessionState {
    read: string[];
    write: string[];
  }

  function makeFactory(
    homeDir: string,
    stateMap: Map<string, StubSessionState>,
  ): AgentFactory {
    return {
      build: async (init) => {
        const agent = new Agent({
          cwd: '/tmp',
          model,
          languageModel: textOnlyModel('hi'),
          tools: {} as ToolSet,
          sandboxMode: 'off',
          home: homeDir,
          contextWindow: 200_000,
          sessionId: init.sessionId,
        });
        if (init.additionalReadPaths) {
          agent.session.additionalReadPaths = init.additionalReadPaths;
        }
        if (init.additionalWritePaths) {
          agent.session.additionalWritePaths = init.additionalWritePaths;
        }
        await writeSessionMetadata(agent.session, homeDir);
        stateMap.set(agent.session.id, {
          read: agent.session.additionalReadPaths,
          write: agent.session.additionalWritePaths,
        });
        return { agent };
      },
      addSessionPath: async (sessionId, kind, path) => {
        const state = stateMap.get(sessionId);
        if (!state) throw new Error('not found');
        const absolute = path;
        if (kind === 'read') {
          if (state.read.includes(absolute)) {
            return { absolute, added: false };
          }
          state.read.push(absolute);
          return { absolute, added: true };
        }
        if (!state.write.includes(absolute)) {
          state.write.push(absolute);
        }
        return { absolute, added: state.write.includes(absolute) };
      },
    };
  }

  async function createSession(app: ReturnType<typeof buildApp>): Promise<string> {
    const response = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model, sandboxMode: 'off' }),
    });
    const { sessionId } = await response.json();
    return sessionId;
  }

  it('GET returns empty read/write arrays for a fresh session', async () => {
    const stateMap = new Map<string, StubSessionState>();
    const registry = new AgentRegistry({
      factory: makeFactory(home, stateMap),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const sessionId = await createSession(app);

    const response = await app.request(`/v1/sessions/${sessionId}/paths`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ read: [], write: [] });
  });

  it('POST read path then GET shows it in read', async () => {
    const stateMap = new Map<string, StubSessionState>();
    const registry = new AgentRegistry({
      factory: makeFactory(home, stateMap),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const sessionId = await createSession(app);

    const postResponse = await app.request(`/v1/sessions/${sessionId}/paths`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'read', path: '/tmp' }),
    });
    expect(postResponse.status).toBe(204);

    const getResponse = await app.request(`/v1/sessions/${sessionId}/paths`);
    expect(getResponse.status).toBe(200);
    const body = await getResponse.json();
    expect(body.read).toEqual(['/tmp']);
    expect(body.write).toEqual([]);
  });

  it('POST with nonexistent path returns 400', async () => {
    const registry = new AgentRegistry({
      factory: {
        build: async () => {
          const agent = new Agent({
            cwd: '/tmp',
            model,
            languageModel: textOnlyModel('hi'),
            tools: {} as ToolSet,
            sandboxMode: 'off',
            home,
            contextWindow: 200_000,
          });
          await writeSessionMetadata(agent.session, home);
          return { agent };
        },
        addSessionPath: async (_sessionId, _kind, path) => {
          throw new Error(`no such file or directory: ${path}`);
        },
      },
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const sessionId = await createSession(app);

    const response = await app.request(`/v1/sessions/${sessionId}/paths`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'read', path: '/does/not/exist' }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('no such file or directory');
  });

  it('POST with invalid body shape returns 400', async () => {
    const stateMap = new Map<string, StubSessionState>();
    const registry = new AgentRegistry({
      factory: makeFactory(home, stateMap),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const sessionId = await createSession(app);

    const response = await app.request(`/v1/sessions/${sessionId}/paths`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'invalid-kind', path: '/tmp' }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('bad request');
    expect(Array.isArray(body.errors)).toBe(true);
  });

  it('GET on unknown session returns 404', async () => {
    const stateMap = new Map<string, StubSessionState>();
    const registry = new AgentRegistry({
      factory: makeFactory(home, stateMap),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });

    const response = await app.request('/v1/sessions/unknown-session-id/paths');
    expect(response.status).toBe(404);
  });

  it('re-POSTing the same path returns 204 and is idempotent', async () => {
    const stateMap = new Map<string, StubSessionState>();
    const registry = new AgentRegistry({
      factory: makeFactory(home, stateMap),
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const sessionId = await createSession(app);

    const first = await app.request(`/v1/sessions/${sessionId}/paths`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'read', path: '/tmp' }),
    });
    expect(first.status).toBe(204);

    const second = await app.request(`/v1/sessions/${sessionId}/paths`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'read', path: '/tmp' }),
    });
    expect(second.status).toBe(204);

    const getResponse = await app.request(`/v1/sessions/${sessionId}/paths`);
    const body = await getResponse.json();
    expect(body.read).toEqual(['/tmp']);
    expect(body.read).toHaveLength(1);
  });
});
