import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChimeraClient } from '@chimera/client';
import { Agent, loadSession, type ModelConfig } from '@chimera/core';
import { AgentRegistry, buildApp } from '@chimera/server';
import { tool } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { expect, it } from 'vitest';
import { z } from 'zod';

it('carries exact pending and committed tool identities through client HTTP and SSE', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-tool-snapshot-'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model: ModelConfig = { providerId: 'mock', modelId: 'm', maxSteps: 3 };
  let step = 0;
  const languageModel = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks:
          step++ === 0
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-call', toolCallId: 'first', toolName: 'capture', input: '{}' },
                { type: 'tool-call', toolCallId: 'sibling', toolName: 'capture', input: '{}' },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'answer' },
                { type: 'text-delta', id: 'answer', delta: 'Implementation is done.' },
                { type: 'text-end', id: 'answer' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
                },
              ],
      }),
    }),
  });
  const registry = new AgentRegistry({
    factory: {
      build: async (init) => ({
        agent: new Agent({
          ...init,
          home,
          contextWindow: 200_000,
          languageModel,
          tools: {
            capture: tool({
              inputSchema: z.object({}),
              execute: async (_args, options) => {
                if (options.toolCallId === 'sibling') await gate;
                return 'captured';
              },
            }),
          },
        }),
      }),
    },
    instance: { pid: 1, cwd: home, version: 'test', sandboxMode: 'off' },
    workspaceCheckpoints: false,
  });
  const app = buildApp({ registry, home });
  const client = new ChimeraClient({
    baseUrl: 'http://fixture.local',
    fetch: (input, init) => app.request(input instanceof Request ? input : String(input), init),
  });
  let sessionId: Awaited<ReturnType<typeof client.createSession>>['sessionId'] | undefined;
  try {
    ({ sessionId } = await client.createSession({ cwd: home, model, sandboxMode: 'off' }));
    let observed = false;
    const started: string[] = [];
    let reply = '';
    for await (const event of client.send(sessionId, 'done?')) {
      if (event.type === 'tool_call_start') started.push(event.callId);
      if (event.type === 'tool_call_result' && event.callId === started[0]) {
        const snapshot = await client.getSession(sessionId);
        expect(snapshot.toolCalls).toMatchObject([
          {
            callId: started[0],
            toolCallId: 'first',
            result: 'captured',
            messageCommitted: false,
            pendingMessage: true,
          },
          { toolCallId: 'sibling', messageCommitted: false, pendingMessage: true },
        ]);
        expect(snapshot.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
        observed = true;
        release();
      }
      if (event.type === 'assistant_text_done') reply = event.text;
    }
    expect(observed).toBe(true);
    expect(reply).toBe('Implementation is done.');
    const final = await client.getSession(sessionId);
    expect(final.status).toBe('idle');
    expect(final.messages[0]).toEqual({ role: 'user', content: 'done?' });
    expect(final.toolCalls.map((call) => call.callId)).toEqual(started);
    expect(final.toolCalls.every((call) => call.messageCommitted && !call.pendingMessage)).toBe(
      true,
    );
    expect((await loadSession(sessionId, home)).toolCalls).toEqual(final.toolCalls);
  } finally {
    release();
    if (sessionId) await registry.delete(sessionId);
    await rm(home, { recursive: true, force: true });
  }
});
