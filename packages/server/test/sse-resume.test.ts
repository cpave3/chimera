import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel, ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { Agent, type ModelConfig } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agent-registry';
import { buildApp } from '../src/app';
import { startServer, type ChimeraServer } from '../src/start';

function slowModel(): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: 20,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'a' },
          { type: 'text-delta', id: 't1', delta: 'b' },
          { type: 'text-delta', id: 't1', delta: 'c' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 },
          },
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

describe('server HTTP + SSE round-trip', () => {
  let home: string;
  let server: ChimeraServer | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-http-'));
  });

  afterEach(async () => {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  });

  it('binds to an ephemeral loopback port and serves /healthz', async () => {
    const model: ModelConfig = { providerId: 'mock', modelId: 'm', maxSteps: 10 };
    const registry = new AgentRegistry({
      factory: {
        build: async () => ({
          agent: new Agent({
            cwd: '/tmp',
            model,
            languageModel: slowModel(),
            tools: {} as ToolSet,
            sandboxMode: 'off',
            home,
          }),
        }),
      },
      instance: { pid: process.pid, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry });
    server = await startServer({ app });

    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);

    const r = await fetch(`${server.url}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok');
  });
});
