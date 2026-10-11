import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliAgentFactory } from '../src/factory';

/** A minimal Anthropic Messages streaming reply with one text block. */
function anthropicStream(text: string): Response {
  const events: Array<[string, unknown]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  const body = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function overloaded(): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    { status: 529, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } },
  );
}

describe('fallbackModel', () => {
  let cwd: string;
  let requestedModels: string[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-fallback-'));
    process.env.CHIMERA_FALLBACK_TEST_KEY = 'test-key';
    requestedModels = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if (!String(input).endsWith('/messages')) return new Response('not found', { status: 404 });
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(model);
      return model === 'claude-opus-4-6'
        ? overloaded()
        : anthropicStream('hello from the fallback');
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.CHIMERA_FALLBACK_TEST_KEY;
    await rm(cwd, { recursive: true, force: true });
  });

  async function runOnce(fallbackModel?: string): Promise<AgentEvent[]> {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          anthropic: {
            shape: 'anthropic',
            baseUrl: 'https://provider.test/v1',
            apiKey: 'env:CHIMERA_FALLBACK_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      warn: () => {},
      subagents: { enabled: false },
      fallbackModel,
    });
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 3 },
      sandboxMode: 'off',
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.run('hi')) events.push(event);
    return events;
  }

  it('moves the run to the configured fallback when the model stays overloaded', async () => {
    const events = await runOnce('anthropic/claude-haiku-4-5');

    expect(requestedModels).toEqual([
      ...Array.from({ length: 5 }, () => 'claude-opus-4-6'),
      'claude-haiku-4-5',
    ]);
    expect(events.find((event) => event.type === 'model_fallback')).toMatchObject({
      from: 'anthropic/claude-opus-4-6',
      to: 'anthropic/claude-haiku-4-5',
    });
    expect(events.find((event) => event.type === 'assistant_text_done')).toMatchObject({
      text: 'hello from the fallback',
    });
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', reason: 'stop' });
  });

  it('ends the run with the provider error when no fallback is configured', async () => {
    const events = await runOnce();

    expect(requestedModels).toHaveLength(5);
    const finished = events.at(-1);
    expect(finished).toMatchObject({ type: 'run_finished', reason: 'error' });
    expect(finished?.type === 'run_finished' ? finished.error : '').toContain('Overloaded');
  });
});
