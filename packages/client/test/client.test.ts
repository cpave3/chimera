import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel, ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { Agent, type ModelConfig } from '@chimera/core';
import { AgentRegistry, buildApp, startServer, type ChimeraServer } from '@chimera/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChimeraClient } from '../src/client';

const model: ModelConfig = { providerId: 'mock', modelId: 'm', maxSteps: 10 };

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
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

describe('ChimeraClient end-to-end', () => {
  let home: string;
  let server: ChimeraServer;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-client-'));
    const registry = new AgentRegistry({
      factory: {
        build: async (init) => ({
          agent: new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('hi there'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
          }),
        }),
      },
      instance: { pid: process.pid, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry });
    server = await startServer({ app });
  });

  afterEach(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true });
  });

  it('createSession + getInstance', async () => {
    const client = new ChimeraClient({ baseUrl: server.url });
    const info = await client.getInstance();
    expect(info.pid).toBe(process.pid);

    const { sessionId } = await client.createSession({
      cwd: '/tmp',
      model,
      sandboxMode: 'off',
    });
    expect(typeof sessionId).toBe('string');

    const s = await client.getSession(sessionId);
    expect(s.id).toBe(sessionId);
    expect(s.cwd).toBe('/tmp');
  });

  it('send yields events ending with run_finished', async () => {
    const client = new ChimeraClient({ baseUrl: server.url });
    const { sessionId } = await client.createSession({
      cwd: '/tmp',
      model,
      sandboxMode: 'off',
    });

    const types: string[] = [];
    for await (const ev of client.send(sessionId, 'hi')) {
      types.push(ev.type);
      if (ev.type === 'run_finished') {
        expect(ev.reason).toBe('stop');
      }
    }
    expect(types[types.length - 1]).toBe('run_finished');
    expect(types).toContain('assistant_text_done');
  });

  it('routes fetch through a custom impl when provided', async () => {
    let called = 0;
    const customFetch: typeof fetch = (input, init) => {
      called += 1;
      return fetch(input, init);
    };
    const client = new ChimeraClient({ baseUrl: server.url, fetch: customFetch });
    await client.getInstance();
    expect(called).toBeGreaterThan(0);
  });

  it('surfaces non-2xx as ChimeraHttpError', async () => {
    const client = new ChimeraClient({ baseUrl: server.url });
    await expect(client.getSession('nonexistent')).rejects.toMatchObject({
      status: 404,
    });
  });
});
