import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compactor } from '@chimera/compaction';
import type { CompactionConfig, ModelLimits } from '@chimera/core';
import { DefaultHookRunner } from '@chimera/hooks';
import { loadProviders, localCapabilities } from '@chimera/providers';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  checkCompactionInvariant,
  compactionModelOptions,
  resolveCompactionConfig,
  startupSessionWindows,
} from '../src/compaction';
import { CliAgentFactory } from '../src/factory';

/**
 * Real CliAgentFactory sessions against a fake Manticore HTTP boundary: the
 * registry's authenticated /model-capabilities discovery serves limits per
 * alias, and chat completions stream back canned responses.
 */
const manticoreSpec = {
  shape: 'openai' as const,
  capabilitySource: 'manticore' as const,
  baseUrl: 'https://router.test/v1',
  apiKey: 'key',
};

function baseCapabilities(modelId: string) {
  return localCapabilities(modelId, {
    ...manticoreSpec,
    adapter: 'compatible' as const,
    requestProfile: 'thinking' as const,
  });
}

let home: string;
let limitsByAlias: Record<string, ModelLimits | null>;
let chatRequests: Array<Record<string, unknown>>;

beforeEach(async () => {
  vi.spyOn(DefaultHookRunner.prototype, 'fire').mockResolvedValue({ blocked: false });
  home = await mkdtemp(join(tmpdir(), 'chimera-discovered-limits-'));
  limitsByAlias = {};
  chatRequests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/model-capabilities')) {
        const alias = url.searchParams.get('model')!;
        const limits = limitsByAlias[alias];
        if (limits === undefined) throw new Error('Discovery unavailable');
        return Response.json({
          ...baseCapabilities('glm-5.3'),
          modelId: alias,
          ...(limits === null ? {} : { limits }),
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      chatRequests.push(body);
      const chunks = [
        { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        },
      ]
        .map(
          (chunk) =>
            `data: ${JSON.stringify({ id: 'test', created: 0, model: body.model, ...chunk })}\n\n`,
        )
        .join('');
      return new Response(`${chunks}data: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

function buildFactory(models: Record<string, unknown> = {}) {
  const warnings: string[] = [];
  const factory = new CliAgentFactory({
    providersConfig: { providers: { router: manticoreSpec } },
    models,
    home,
    autoApprove: 'all',
    subagents: { enabled: false },
    warn: (message) => warnings.push(message),
  });
  return { factory, warnings };
}

async function buildAgent(factory: CliAgentFactory, modelId: string) {
  const built = await factory.build({
    cwd: home,
    model: { providerId: 'router', modelId, maxSteps: 1 },
    sandboxMode: 'off',
  });
  return built.agent;
}

it('gives an unknown alias its discovered window without an override or warning', async () => {
  limitsByAlias['glm-go'] = {
    context: { status: 'discovered', value: 262_144 },
    input: { status: 'discovered', value: 131_072 },
    output: { status: 'discovered', value: 32_768 },
  };
  const { factory, warnings } = buildFactory();
  const agent = await buildAgent(factory, 'glm-go');
  expect(agent.contextBreakdown().contextWindow).toBe(262_144);
  expect(warnings.join('\n')).not.toContain('unknown context window');
});

it('keeps an explicitly configured context window over discovery', async () => {
  limitsByAlias['glm-go'] = {
    context: { status: 'discovered', value: 262_144 },
    input: { status: 'unknown' },
    output: { status: 'unknown' },
  };
  const { factory } = buildFactory({ 'router/glm-go': { contextWindow: 100_000 } });
  const agent = await buildAgent(factory, 'glm-go');
  expect(agent.contextBreakdown().contextWindow).toBe(100_000);
});

it('falls back to the conservative window when discovery is unavailable or unknown', async () => {
  const { factory, warnings } = buildFactory();
  const unavailableAgent = await buildAgent(factory, 'glm-go');
  expect(unavailableAgent.contextBreakdown().contextWindow).toBe(128_000);
  expect(warnings.join('\n')).toContain('unknown context window');

  limitsByAlias['glm-go'] = {
    context: { status: 'unknown' },
    input: { status: 'unknown' },
    output: { status: 'unknown' },
  };
  const { factory: secondFactory } = buildFactory();
  const unknownAgent = await buildAgent(secondFactory, 'glm-go');
  expect(unknownAgent.contextBreakdown().contextWindow).toBe(128_000);
});

it('moves the session onto another alias with its own discovered window', async () => {
  limitsByAlias['glm-go'] = {
    context: { status: 'discovered', value: 262_144 },
    input: { status: 'unknown' },
    output: { status: 'unknown' },
  };
  limitsByAlias.kimi = {
    context: { status: 'discovered', value: 512_000 },
    input: { status: 'discovered', value: 262_144 },
    output: { status: 'unknown' },
  };
  const { factory } = buildFactory();
  const agent = await buildAgent(factory, 'glm-go');
  const applied = await agent.updateModelSettings({ model: 'router/kimi' });
  expect(applied.status).toBe('applied');
  expect(agent.contextBreakdown().contextWindow).toBe(512_000);
});

it('bounds the default output budget by the discovered cap on the wire', async () => {
  limitsByAlias['glm-go'] = {
    context: { status: 'discovered', value: 262_144 },
    input: { status: 'unknown' },
    output: { status: 'discovered', value: 12_000 },
  };
  const { factory } = buildFactory();
  const agent = await buildAgent(factory, 'glm-go');
  const events = [];
  for await (const event of agent.run('hi')) events.push(event);
  expect(events.find((event) => event.type === 'run_finished')).toMatchObject({ reason: 'stop' });
  // The profile heuristic for a 262_144 window is 20_972 tokens; the
  // discovered output cap of 12_000 bounds it.
  expect(chatRequests.at(-1)?.max_tokens).toBe(12_000);
});

it('rejects an explicit output limit above the discovered cap', async () => {
  limitsByAlias['glm-go'] = {
    context: { status: 'unknown' },
    input: { status: 'unknown' },
    output: { status: 'discovered', value: 12_000 },
  };
  const { factory } = buildFactory({ 'router/glm-go': { maxOutputTokens: 40_000 } });
  await expect(buildAgent(factory, 'glm-go')).rejects.toThrow(
    /discovered output limit of 12000 tokens/,
  );
});

it('still discovers limits for a requestProfile-pinned model without adopting the fetched profile', async () => {
  limitsByAlias['glm-go'] = {
    context: { status: 'discovered', value: 262_144 },
    input: { status: 'unknown' },
    output: { status: 'unknown' },
  };
  const { factory } = buildFactory({ 'router/glm-go': { requestProfile: 'openai-chat' } });
  const agent = await buildAgent(factory, 'glm-go');
  expect(agent.contextBreakdown().contextWindow).toBe(262_144);
  const state = await factory.getModelCapabilities('router/glm-go');
  expect(state.profile).toBe('openai-chat');
});

const smallInputLimits: ModelLimits = {
  context: { status: 'discovered', value: 262_144 },
  input: { status: 'discovered', value: 6_000 },
  output: { status: 'discovered', value: 32_768 },
};

it('compacts on the small discovered input cap and bounds the actual sends', async () => {
  limitsByAlias['glm-go'] = smallInputLimits;
  const summaryPrompts: string[] = [];
  const summaryOutputs: (number | undefined)[] = [];
  const summaryModel = new MockLanguageModelV3({
    doGenerate: async (options) => {
      summaryPrompts.push(String(options.prompt ?? JSON.stringify(options.messages)));
      summaryOutputs.push(options.maxOutputTokens);
      return {
        content: [{ type: 'text', text: '## Goal\nsummary\n<files></files>' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      };
    },
  });
  const registry = loadProviders({ providers: { router: manticoreSpec } });
  const config = {
    providers: { router: manticoreSpec },
    models: {},
    compaction: { reserveTokens: 1_000, keepRecentTokens: 500, thresholdPercent: 85 },
  };
  const compactor = new Compactor({
    home,
    contextWindow: 6_000,
    config: resolveCompactionConfig({ config }),
    ...compactionModelOptions(config, registry),
    resolveModel: async () => summaryModel,
  });
  const warnings: string[] = [];
  const factory = new CliAgentFactory({
    providersConfig: { providers: { router: manticoreSpec } },
    models: {},
    home,
    autoApprove: 'all',
    subagents: { enabled: false },
    warn: (message) => warnings.push(message),
    compaction: resolveCompactionConfig({ config }),
    compactor,
  });
  const agent = await buildAgent(factory, 'glm-go');
  // ~5_000 estimated tokens: far under the 262_144 total context, but over
  // the 3_000 effective trigger on the 6_000 input basis (output reserve
  // floor 25_067 clamps to basis/2, so window - reserve = 3_000).
  agent.session.messages.push({ role: 'user', content: 'x'.repeat(20_000) });

  const events: Array<{ type: string; error?: string }> = [];
  for await (const event of agent.run('go')) events.push(event);

  expect(events.some((event) => event.type === 'compaction_started')).toBe(true);
  // The summarize call obeys the discovered input basis: its prompt is
  // bounded to half the basis and its output cap to a quarter of it.
  expect(summaryPrompts).toHaveLength(1);
  expect(summaryPrompts[0]!.length).toBeLessThanOrEqual((6_000 / 2) * 4);
  expect(summaryOutputs[0]).toBeLessThanOrEqual(6_000 / 4);
  // The run's own request stays inside the input cap.
  const request = chatRequests.at(-1)!;
  const promptChars = JSON.stringify(request.messages).length;
  expect(promptChars / 4).toBeLessThan(6_000);
});

it('returns an actionable error when a discovered window invalidates the compaction config', async () => {
  limitsByAlias['glm-go'] = smallInputLimits;
  const { factory } = buildFactory();
  // Default compaction config (16_384 reserve + 20_000 keep-recent) cannot
  // fit the discovered 6_000-token input basis.
  (factory as unknown as { compaction: CompactionConfig }).compaction = {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    thresholdPercent: 85,
  };
  await expect(buildAgent(factory, 'glm-go')).rejects.toThrow(/Compaction invariant violated/);

  limitsByAlias.kimi = smallInputLimits;
  limitsByAlias['glm-go'] = {
    context: { status: 'discovered', value: 262_144 },
    input: { status: 'unknown' },
    output: { status: 'unknown' },
  };
  const { factory: secondFactory } = buildFactory();
  (secondFactory as unknown as { compaction: CompactionConfig }).compaction = {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    thresholdPercent: 85,
  };
  const agent = await buildAgent(secondFactory, 'glm-go');
  const applied = await agent.updateModelSettings({ model: 'router/kimi' });
  expect(applied.status).toBe('invalid');
  if (applied.status === 'invalid')
    expect(applied.error).toContain('Compaction invariant violated');
});

it('resolves the startup model windows for the command invariant check after discovery', async () => {
  limitsByAlias['glm-go'] = smallInputLimits;
  const registry = loadProviders({ providers: { router: manticoreSpec } });
  const windows = await startupSessionWindows(
    {
      providers: { router: manticoreSpec },
      models: { 'router/glm-go': { contextWindow: 200_000 } },
    },
    registry,
    'router/glm-go',
  );
  // Explicit override wins over the discovered context, and the discovered
  // input cap still clamps the prompt basis.
  expect(windows.context).toEqual({ value: 200_000, source: 'override' });
  expect(windows.inputLimit).toBe(6_000);
  expect(windows.promptBasis).toBe(6_000);

  const invariant = checkCompactionInvariant(
    {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      thresholdPercent: 85,
    },
    windows.promptBasis,
  );
  expect(invariant.ok).toBe(false);
  if (!invariant.ok) expect(invariant.error).toContain('contextWindow (6000)');

  const discovery = vi.mocked(fetch);
  await startupSessionWindows(
    { providers: { router: manticoreSpec }, models: {} },
    registry,
    'router/glm-go',
  );
  expect(discovery).toHaveBeenCalledTimes(1);
});

it('reuses a shared registry so the factory adds no second discovery fetch', async () => {
  limitsByAlias['glm-go'] = smallInputLimits;
  const registry = loadProviders({ providers: { router: manticoreSpec } });
  await startupSessionWindows(
    { providers: { router: manticoreSpec }, models: {} },
    registry,
    'router/glm-go',
  );
  const discovery = vi.mocked(fetch);
  const factory = new CliAgentFactory({
    providersConfig: { providers: { router: manticoreSpec } },
    models: {},
    registry,
    home,
    autoApprove: 'all',
    subagents: { enabled: false },
  });
  const agent = await buildAgent(factory, 'glm-go');
  expect(agent.contextBreakdown().contextWindow).toBe(262_144);
  expect(discovery).toHaveBeenCalledTimes(1);
});
