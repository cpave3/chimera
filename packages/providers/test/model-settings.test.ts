import { generateText, jsonSchema, streamText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertModelCapabilities,
  localCapabilities,
  resolveModelSettings,
} from '../src/model-settings';
import { loadProviders } from '../src/registry';

afterEach(() => vi.unstubAllGlobals());

describe('model settings requests', () => {
  it('describes verified image models and validates optional discovered modalities', () => {
    const anthropic = localCapabilities('claude-opus-4-6', {
      shape: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'key',
    });
    expect(anthropic.inputModalities).toEqual(['text', 'image']);
    expect(
      localCapabilities('gpt-4.1', {
        shape: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'key',
      }).inputModalities,
    ).toEqual(['text', 'image']);
    expect(
      localCapabilities('gpt-4.1', {
        shape: 'openai',
        baseUrl: 'http://localhost:1234/v1',
        apiKey: 'key',
      }).inputModalities,
    ).toBeUndefined();
    expect(() => assertModelCapabilities({ ...anthropic, inputModalities: ['imaginary'] })).toThrow(
      'modalities',
    );
    expect(() => assertModelCapabilities({ ...anthropic, inputModalities: 'image' })).toThrow(
      'modalities',
    );
    expect(() => assertModelCapabilities({ ...anthropic, inputModalities: [] })).toThrow(
      'modalities',
    );
    expect(() =>
      assertModelCapabilities({ ...anthropic, inputModalities: undefined }),
    ).not.toThrow();
  });
  it('serializes native Anthropic parallel-tool Off', async () => {
    const spec = {
      shape: 'anthropic' as const,
      baseUrl: 'https://anthropic.test/v1',
      apiKey: 'key',
    };
    const resolved = resolveModelSettings(
      spec,
      localCapabilities('claude-sonnet-4-5', spec),
      {},
      { parallelToolCalls: false },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body)).tool_choice).toEqual({
          type: 'auto',
          disable_parallel_tool_use: true,
        });
        return Response.json({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }),
    );
    await generateText({
      model: loadProviders({ providers: { native: spec } })
        .get('native')
        .getModel('claude-sonnet-4-5'),
      prompt: 'test',
      tools: { test: { inputSchema: jsonSchema({ type: 'object', properties: {} }) } },
      providerOptions: resolved.providerOptions,
    });
  });
  it('keeps legacy native-compatible defaults usable without requiring new thinking controls', () => {
    const spec = {
      shape: 'openai' as const,
      baseUrl: 'https://api.synthetic.new/v1',
      apiKey: 'key',
    };
    expect(
      resolveModelSettings(spec, localCapabilities('GLM-4.7', spec), { maxOutputTokens: 32768 })
        .settings.maxOutputTokens,
    ).toBe(32768);
  });
  it.each(['GLM-5.3', 'kimi-k2.7-code'])('does not offer Thinking Off for %s', (modelId) => {
    const caps = localCapabilities(modelId, {
      shape: 'openai',
      adapter: 'compatible',
      baseUrl: 'https://api.synthetic.new/v1',
      apiKey: 'key',
    });
    expect(caps.settings.thinking.values).toEqual(['on']);
  });
  it('serializes compatible Thinking Off and zero sampling without inherited reasoning', async () => {
    const spec = {
      shape: 'openai' as const,
      adapter: 'compatible' as const,
      requestProfile: 'template' as const,
      baseUrl: 'https://local.test/v1',
      apiKey: 'key',
      headers: { 'X-Session': '{{session.id}}' },
    };
    const capabilities = localCapabilities('local', spec);
    capabilities.settings.temperature = { status: 'supported', type: 'number', min: 0, max: 2 };
    capabilities.settings.topP = { status: 'supported', type: 'number', min: 0, max: 1 };
    const resolved = resolveModelSettings(
      spec,
      capabilities,
      { reasoningEffort: 'high' },
      { thinking: 'off', temperature: 0, topP: 0 },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        expect(request).toMatchObject({
          chat_template_kwargs: { enable_thinking: false },
          temperature: 0,
          top_p: 0,
        });
        expect(request.reasoning_effort).toBeUndefined();
        expect(new Headers(init?.headers).get('X-Session')).toBe('session-1');
        return new Response(
          JSON.stringify({
            id: '1',
            created: 1,
            model: 'local',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
          }),
        );
      }),
    );
    await generateText({
      model: loadProviders({ providers: { local: spec } })
        .get('local')
        .getModel('local', 'session-1'),
      prompt: 'test',
      temperature: resolved.settings.temperature,
      topP: resolved.settings.topP,
      providerOptions: resolved.providerOptions,
    });
  });

  it.each([
    'on',
    'off',
  ] as const)('serializes native Anthropic thinking %s and its budget', async (thinking) => {
    const spec = {
      shape: 'anthropic' as const,
      baseUrl: 'https://anthropic.test/v1',
      apiKey: 'key',
    };
    const resolved = resolveModelSettings(
      spec,
      localCapabilities('claude-sonnet-4-5', spec),
      {},
      {
        thinking,
        maxOutputTokens: 4096,
        ...(thinking === 'on' ? { thinkingBudgetTokens: 2048 } : {}),
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          max_tokens: 4096,
          thinking:
            thinking === 'on' ? { type: 'enabled', budget_tokens: 2048 } : { type: 'disabled' },
        });
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      }),
    );
    await generateText({
      model: loadProviders({ providers: { native: spec } })
        .get('native')
        .getModel('claude-sonnet-4-5'),
      prompt: 'test',
      maxOutputTokens: resolved.settings.maxOutputTokens,
      providerOptions: resolved.providerOptions,
    });
  });

  it('does not advertise effort values that the selected native adapter cannot serialize', () => {
    const capabilities = localCapabilities('gpt-5.6-sol', {
      shape: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'key',
    });
    expect(capabilities.settings.reasoningEffort.values).not.toContain('max');
  });

  it('caches authenticated discovery, refreshes changed aliases, and reports outages as unknown', async () => {
    const spec = {
      shape: 'openai' as const,
      capabilitySource: 'manticore' as const,
      baseUrl: 'https://proxy.test/v1',
      apiKey: 'key',
    };
    const provider = loadProviders({ providers: { proxy: spec } }).get('proxy');
    const caps = localCapabilities('gpt-5.6-sol', { ...spec, requestProfile: 'openai-chat' });
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer key');
      return Response.json(caps);
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await provider.getCapabilities('sol')).toEqual(caps);
    await provider.getCapabilities('sol');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(
      Response.json({ ...caps, modelId: 'gpt-5.6-luna', fingerprint: 'changed' }),
    );
    expect((await provider.getCapabilities('sol', true)).modelId).toBe('gpt-5.6-luna');
    fetchMock.mockRejectedValue(new Error('offline'));
    expect((await provider.getCapabilities('sol', true)).source).toBe('unavailable');
  });

  it('rejects unknown options, contradictory thinking, and extension collisions', () => {
    const spec = {
      shape: 'openai' as const,
      adapter: 'compatible' as const,
      baseUrl: 'https://local.test/v1',
      apiKey: 'key',
    };
    const caps = localCapabilities('gpt-5.6-sol', { ...spec, requestProfile: 'openai-chat' });
    expect(() =>
      resolveModelSettings(spec, caps, {}, { thinking: 'off', reasoningEffort: 'high' }),
    ).toThrow('conflicts');
    expect(() => resolveModelSettings(spec, caps, {}, {}, { messages: [] })).toThrow('conflicts');
    expect(() =>
      resolveModelSettings(spec, localCapabilities('unknown', spec), {}, { thinking: 'off' }),
    ).toThrow();
  });
  it.each([
    false,
    true,
  ])('preserves opaque Codex metadata through the SDK tool continuation (stream=%s)', async (streaming) => {
    const items = [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] }];
    const provider = loadProviders({
      providers: {
        proxy: {
          shape: 'openai',
          capabilitySource: 'manticore',
          baseUrl: 'https://proxy.test/v1',
          apiKey: 'key',
        },
      },
    }).get('proxy');
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (fetchMock.mock.calls.length > 1)
        expect(request.messages[1].tool_calls[0].codex_reasoning).toEqual(items);
      const message = {
        role: 'assistant',
        content: null,
        codex_reasoning: items,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } },
        ],
      };
      if (!request.stream)
        return new Response(
          JSON.stringify({
            id: '1',
            created: 1,
            model: 'sol',
            choices: [{ index: 0, message, finish_reason: 'tool_calls' }],
          }),
        );
      const chunks = [
        {
          choices: [
            {
              index: 0,
              delta: {
                codex_reasoning: items,
                tool_calls: [{ ...message.tool_calls[0], index: 0 }],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const model = provider.getModel('sol');
    const result = streaming
      ? streamText({ model, prompt: 'hello' })
      : await generateText({ model, prompt: 'hello' });
    if (streaming) await (result as ReturnType<typeof streamText>).consumeStream();
    const response = await result.response;
    await generateText({
      model,
      messages: [
        { role: 'user', content: 'hello' },
        ...response.messages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'test',
              output: { type: 'text', value: 'done' },
            },
          ],
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('sends explicit compatible settings without dropping max effort, false, or zero', async () => {
    const spec = {
      shape: 'openai' as const,
      adapter: 'compatible' as const,
      baseUrl: 'https://proxy.test/v1',
      apiKey: 'key',
    };
    const provider = loadProviders({ providers: { proxy: spec } }).get('proxy');
    const capabilities = localCapabilities('gpt-5.6-sol', {
      ...spec,
      requestProfile: 'openai-chat',
    });
    const resolved = resolveModelSettings(
      spec,
      capabilities,
      {},
      {
        reasoningEffort: 'max',
        parallelToolCalls: false,
        verbosity: 'high',
        serviceTier: 'priority',
      },
    );
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'sol',
        reasoning_effort: 'max',
        parallel_tool_calls: false,
        verbosity: 'high',
        service_tier: 'priority',
      });
      return new Response(
        JSON.stringify({
          id: '1',
          created: 1,
          model: 'sol',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    await generateText({
      model: provider.getModel('sol'),
      prompt: 'hello',
      providerOptions: resolved.providerOptions,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
