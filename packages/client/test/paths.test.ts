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

describe('ChimeraClient paths', () => {
  let home: string;
  let server: ChimeraServer;
  const agents = new Map<string, Agent>();

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-client-paths-'));
    agents.clear();
    const registry = new AgentRegistry({
      factory: {
        build: async (init) => {
          const agent = new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('hi there'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          });
          agents.set(agent.session.id, agent);
          return { agent };
        },
        addSessionPath: async (sessionId, kind, path) => {
          const agent = agents.get(sessionId);
          if (!agent) throw new Error('not found');
          if (path === '/does/not/exist') {
            throw new Error(`no such file or directory: ${path}`);
          }
          const absolute = path;
          if (kind === 'read') {
            if (agent.session.additionalReadPaths.includes(absolute)) {
              return { absolute, added: false };
            }
            agent.session.additionalReadPaths.push(absolute);
            return { absolute, added: true };
          }
          if (!agent.session.additionalWritePaths.includes(absolute)) {
            agent.session.additionalWritePaths.push(absolute);
          }
          return { absolute, added: agent.session.additionalWritePaths.includes(absolute) };
        },
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

  it('listPaths calls GET and returns the parsed body', async () => {
    const client = new ChimeraClient({ baseUrl: server.url });
    const { sessionId } = await client.createSession({
      cwd: '/tmp',
      model,
      sandboxMode: 'off',
    });

    const paths = await client.listPaths(sessionId);
    expect(paths).toEqual({ read: [], write: [] });
  });

  it('addPath posts the right body', async () => {
    const client = new ChimeraClient({ baseUrl: server.url });
    const { sessionId } = await client.createSession({
      cwd: '/tmp',
      model,
      sandboxMode: 'off',
    });

    await client.addPath(sessionId, 'read', '/tmp');

    const paths = await client.listPaths(sessionId);
    expect(paths.read).toEqual(['/tmp']);
    expect(paths.write).toEqual([]);
  });

  it('400 response throws ChimeraHttpError with status 400', async () => {
    const client = new ChimeraClient({ baseUrl: server.url });
    const { sessionId } = await client.createSession({
      cwd: '/tmp',
      model,
      sandboxMode: 'off',
    });

    await expect(client.addPath(sessionId, 'read', '/does/not/exist')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('404 response throws ChimeraHttpError with status 404', async () => {
    const client = new ChimeraClient({ baseUrl: server.url });
    await expect(client.listPaths('nonexistent-session')).rejects.toMatchObject({
      status: 404,
    });
  });
});
