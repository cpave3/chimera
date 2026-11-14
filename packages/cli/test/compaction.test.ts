import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compactor } from '@chimera/compaction';
import type { Session } from '@chimera/core';
import { Agent } from '@chimera/core';
import { loadProviders } from '@chimera/providers';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkCompactionInvariant,
  compactionCallOptions,
  compactionModelOptions,
  resolveCompactionConfig,
} from '../src/compaction';
import { resolveModel } from '../src/config';

describe('resolveCompactionConfig', () => {
  it('wires the configured utility fallback and its own window into real compaction', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chimera-summary-options-'));
    try {
      const config = {
        providers: {
          direct: {
            shape: 'openai' as const,
            adapter: 'compatible' as const,
            baseUrl: 'https://example.invalid/v1',
            apiKey: 'test',
          },
        },
        models: { 'direct/utility': { contextWindow: 4_000 } },
        utilityModel: 'direct/utility',
        compaction: { model: 'direct/summary' },
      };
      const refs: string[] = [];
      const outputs: (number | undefined)[] = [];
      const summary = new MockLanguageModelV3({
        doGenerate: async (options) => {
          outputs.push(options.maxOutputTokens);
          return {
            content: [{ type: 'text', text: 'summary' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            warnings: [],
          };
        },
      });
      const agent = new Agent({
        home,
        cwd: '/tmp',
        languageModel: summary,
        tools: {},
        model: { providerId: 'direct', modelId: 'main', maxSteps: 1 },
        contextWindow: 16_000,
        sandboxMode: 'off',
      });
      agent.session.messages.push({ role: 'user', content: 'history '.repeat(10_000) });
      const compactor = new Compactor({
        home,
        contextWindow: 16_000,
        config: resolveCompactionConfig({ config }),
        ...compactionModelOptions(config, loadProviders({ providers: config.providers })),
        resolveModel: async (ref) => {
          refs.push(ref);
          if (ref === 'direct/summary') throw new Error('summary unavailable');
          return summary;
        },
      });
      const result = await compactor.compact(agent.session, 'manual');
      expect(refs).toContain('direct/utility');
      expect(outputs[0]).toBe(1_000);
      expect(result.summary).toContain('summary');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uses active session settings or the explicit compaction model defaults', async () => {
    const providers = {
      direct: {
        shape: 'openai' as const,
        adapter: 'compatible' as const,
        requestProfile: 'openai-chat' as const,
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'key',
      },
    };
    const resolve = compactionCallOptions(
      { providers, models: { 'direct/gpt-5.6-luna': { settings: { reasoningEffort: 'low' } } } },
      loadProviders({ providers }),
    );
    const session = {
      model: {
        providerId: 'direct',
        modelId: 'gpt-5.6-sol',
        settings: { reasoningEffort: 'max', parallelToolCalls: false },
      },
      modelSettingsOverrides: {
        'direct/gpt-5.6-sol': { reasoningEffort: 'max', parallelToolCalls: false },
      },
    } as Session;
    expect((await resolve('direct/gpt-5.6-sol', session)).providerOptions?.chimera).toMatchObject({
      reasoningEffort: 'max',
      parallel_tool_calls: false,
    });
    expect((await resolve('direct/gpt-5.6-luna', session)).providerOptions?.chimera).toEqual({
      reasoningEffort: 'low',
    });
  });
  it('defaults to enabled with Chimera defaults', () => {
    const config = resolveCompactionConfig({ config: {} });
    expect(config.enabled).toBe(true);
    expect(config.reserveTokens).toBe(16384);
    expect(config.keepRecentTokens).toBe(20000);
    expect(config.model).toBeUndefined();
  });

  it('summarizes on the utility model unless compaction names its own', () => {
    expect(resolveCompactionConfig({ config: { utilityModel: 'a/cheap' } }).model).toBe('a/cheap');
    expect(
      resolveCompactionConfig({
        config: { utilityModel: 'a/cheap', compaction: { model: 'b/summary' } },
      }).model,
    ).toBe('b/summary');
  });

  it('reads values from config.compaction', () => {
    const config = resolveCompactionConfig({
      config: {
        compaction: {
          enabled: false,
          reserveTokens: 5000,
          keepRecentTokens: 8000,
          model: 'anthropic/claude-sonnet-4-5',
        },
      },
    });
    expect(config.enabled).toBe(false);
    expect(config.reserveTokens).toBe(5000);
    expect(config.keepRecentTokens).toBe(8000);
    expect(config.model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('honors --no-compaction from CLI (cliOverride false)', () => {
    const config = resolveCompactionConfig({
      cliOverride: false,
      config: { compaction: { enabled: true } },
    });
    expect(config.enabled).toBe(false);
  });

  it('defaults thresholdPercent to 85 and reads overrides', () => {
    expect(resolveCompactionConfig({ config: {} }).thresholdPercent).toBe(85);
    expect(
      resolveCompactionConfig({ config: { compaction: { thresholdPercent: 70 } } })
        .thresholdPercent,
    ).toBe(70);
  });

  it('old-keys-only configs resolve identically plus the new default', () => {
    const config = resolveCompactionConfig({
      config: { compaction: { reserveTokens: 5000, keepRecentTokens: 8000 } },
    });
    expect(config).toEqual({
      enabled: true,
      reserveTokens: 5000,
      keepRecentTokens: 8000,
      model: undefined,
      thresholdPercent: 85,
    });
  });
});

describe('checkCompactionInvariant', () => {
  it('passes when reserve + keepRecent < contextWindow', () => {
    const result = checkCompactionInvariant(
      { reserveTokens: 16000, keepRecentTokens: 20000 },
      200_000,
    );
    expect(result.ok).toBe(true);
  });

  it('fails when reserve + keepRecent >= contextWindow', () => {
    const result = checkCompactionInvariant(
      { reserveTokens: 80_000, keepRecentTokens: 80_000 },
      128_000,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Compaction invariant violated/);
    expect(result.error).toMatch(/128000/);
  });

  it('rejects thresholdPercent outside [50, 95]', () => {
    const low = checkCompactionInvariant(
      { reserveTokens: 16_000, keepRecentTokens: 20_000, thresholdPercent: 40 },
      200_000,
    );
    expect(low.ok).toBe(false);
    expect(low.error).toMatch(/thresholdPercent/);
    const high = checkCompactionInvariant(
      { reserveTokens: 16_000, keepRecentTokens: 20_000, thresholdPercent: 99 },
      200_000,
    );
    expect(high.ok).toBe(false);
  });

  it('fails when the keep-tail cannot fit under the effective trigger', () => {
    // 100k window @85% → 85k trigger; keepRecent 80k + reserve 16k overflows it.
    const result = checkCompactionInvariant(
      { reserveTokens: 16_000, keepRecentTokens: 80_000, thresholdPercent: 85 },
      100_000,
    );
    expect(result.ok).toBe(false);
  });

  it('passes typical 100k/200k/250k window configurations with defaults', () => {
    for (const window of [100_000, 200_000, 250_000]) {
      const result = checkCompactionInvariant(
        { reserveTokens: 16_384, keepRecentTokens: 20_000, thresholdPercent: 85 },
        window,
      );
      expect(result.ok).toBe(true);
    }
  });
});

describe('config compaction model resolution', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-compaction-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('resolveModel accepts a compaction.model ref in providerId/modelId format', () => {
    const resolved = resolveModel({
      cliModel: 'openrouter/some-model',
      config: {
        defaultModel: 'anthropic/claude-opus-4-7',
        providers: {
          anthropic: { shape: 'anthropic', baseUrl: 'x', apiKey: 'env:A' },
          openrouter: { shape: 'openai', baseUrl: 'x', apiKey: 'env:O' },
        },
      },
    });
    expect(resolved.ref).toBe('openrouter/some-model');
    expect(resolved.model.providerId).toBe('openrouter');
    expect(resolved.model.modelId).toBe('some-model');
  });
});
