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

function textModel(text: string): LanguageModel {
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

const model: ModelConfig = { providerId: 'mock', modelId: 'm', maxSteps: 10 };

function makeFactory(home: string, text = 'hello') {
  return {
    build: async (init: { requestedSessionId?: string; sessionId?: string }) => {
      const agent = new Agent({
        cwd: '/tmp',
        model,
        languageModel: textModel(text),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        sessionId: init.requestedSessionId ?? init.sessionId,
      });
      return { agent };
    },
  };
}

/** Parse SSE text into a list of { event, id, data } objects. */
function parseSSE(text: string): { event?: string; id?: string; data?: string }[] {
  const events: { event?: string; id?: string; data?: string }[] = [];
  let current: { event?: string; id?: string; data?: string } = {};
  for (const line of text.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line === '') {
      if (Object.keys(current).length > 0) {
        events.push(current);
        current = {};
      }
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon > 0 ? line.slice(0, colon) : line;
    const value = colon > 0 ? line.slice(colon + 1).trimStart() : '';
    if (field === 'event') current.event = value;
    else if (field === 'id') current.id = value;
    else if (field === 'data') current.data = current.data ? current.data + '\n' + value : value;
  }
  return events;
}

describe('SSE replay race', () => {
  let home: string;
  let server: ChimeraServer | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-sse-race-'));
  });

  afterEach(async () => {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  });

  it('events published between replay and subscribe are not lost', async () => {
    const registry = new AgentRegistry({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: makeFactory(home, 'hello') as any,
      instance: { pid: process.pid, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry });
    server = await startServer({ app });

    const createRes = await fetch(`${server.url}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model }),
    });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    // Start a run to produce events.
    await fetch(`${server.url}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    await new Promise((r) => setTimeout(r, 200));

    const entry = registry.get(sessionId)!;
    const ringSnapshot = entry.bus.snapshot();
    const sinceId = ringSnapshot[0]?.eventId;

    // Open SSE stream.  The fix ensures subscribe happens before replay,
    // so events published during replay are captured in the live buffer.
    const sseUrl = new URL(`${server.url}/v1/sessions/${sessionId}/events`);
    if (sinceId) sseUrl.searchParams.set('since', sinceId);

    const controller = new AbortController();
    const response = await fetch(sseUrl, { signal: controller.signal });
    const reader = response.body!.getReader();

    // Read a chunk to let the stream open and replay.
    await reader.read();

    // Publish an event after the stream is open.
    entry.bus.publish({ type: 'user_message', content: 'injected' });
    await new Promise((r) => setTimeout(r, 100));
    const { value } = await reader.read();
    controller.abort();

    const text = new TextDecoder().decode(value ?? new Uint8Array());
    const events = parseSSE(text);
    const injected = events.find((e) => e.data?.includes('injected'));
    expect(injected).toBeDefined();
  });

  it('concurrent SSE subscribers both receive all events without duplication', async () => {
    const registry = new AgentRegistry({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: makeFactory(home, 'world') as any,
      instance: { pid: process.pid, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry });
    server = await startServer({ app });

    const createRes = await fetch(`${server.url}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', model }),
    });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const sseUrl = `${server.url}/v1/sessions/${sessionId}/events`;
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const res1 = await fetch(sseUrl, { signal: ctrl1.signal });
    const res2 = await fetch(sseUrl, { signal: ctrl2.signal });
    const reader1 = res1.body!.getReader();
    const reader2 = res2.body!.getReader();

    const entry = registry.get(sessionId)!;
    entry.bus.publish({ type: 'user_message', content: 'shared' });

    await new Promise((r) => setTimeout(r, 100));
    const { value: v1 } = await reader1.read();
    const { value: v2 } = await reader2.read();

    ctrl1.abort();
    ctrl2.abort();

    const events1 = parseSSE(new TextDecoder().decode(v1 ?? new Uint8Array()));
    const events2 = parseSSE(new TextDecoder().decode(v2 ?? new Uint8Array()));

    const shared1 = events1.filter((e) => e.data?.includes('shared'));
    const shared2 = events2.filter((e) => e.data?.includes('shared'));
    expect(shared1).toHaveLength(1);
    expect(shared2).toHaveLength(1);
  });
});
