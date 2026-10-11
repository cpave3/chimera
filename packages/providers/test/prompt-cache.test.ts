import { generateText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProviders } from '../src/registry';
import type { ProviderSpec } from '../src/types';

const ANTHROPIC_REPLY = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const OPENAI_REPLY = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

describe('prompt cache markers', () => {
  let requestBodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    process.env.PROMPT_CACHE_TEST_KEY = 'test-key';
    requestBodies = [];
  });

  afterEach(() => {
    delete process.env.PROMPT_CACHE_TEST_KEY;
    vi.unstubAllGlobals();
  });

  function stubProvider(reply: unknown): void {
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  }

  async function callModel(spec: Partial<ProviderSpec> & Pick<ProviderSpec, 'shape'>) {
    const registry = loadProviders({
      providers: {
        test: { baseUrl: 'https://provider.test/v1', apiKey: 'env:PROMPT_CACHE_TEST_KEY', ...spec },
      },
    });
    await generateText({
      model: registry.get('test').getModel('model-test'),
      system: 'You are a test agent.',
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ],
    });
    return requestBodies[0]!;
  }

  it('marks the system prompt and the last message for an Anthropic-shape provider', async () => {
    stubProvider(ANTHROPIC_REPLY);

    const body = await callModel({ shape: 'anthropic' });

    const system = body.system as Array<Record<string, unknown>>;
    expect(system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(messages[0]?.content.at(-1)?.cache_control).toBeUndefined();
  });

  it('sends no marker when the provider turns prompt caching off', async () => {
    stubProvider(ANTHROPIC_REPLY);

    const body = await callModel({ shape: 'anthropic', promptCaching: false });

    expect(JSON.stringify(body)).not.toContain('cache_control');
  });

  it('sends no marker for an OpenAI-shape provider', async () => {
    stubProvider(OPENAI_REPLY);

    const body = await callModel({ shape: 'openai' });

    expect(body.messages).toHaveLength(4);
    expect(JSON.stringify(body)).not.toMatch(/cache_control|cacheControl/);
  });
});
