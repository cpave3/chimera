import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCompactionInvariant, resolveCompactionConfig } from '../src/compaction';
import { resolveModel } from '../src/config';

describe('resolveCompactionConfig', () => {
  it('defaults to enabled with Chimera defaults', () => {
    const config = resolveCompactionConfig({ config: {} });
    expect(config.enabled).toBe(true);
    expect(config.reserveTokens).toBe(16384);
    expect(config.keepRecentTokens).toBe(20000);
    expect(config.model).toBeUndefined();
  });

  it('reads values from config.compaction', () => {
    const config = resolveCompactionConfig({
      config: {
        compaction: { enabled: false, reserveTokens: 5000, keepRecentTokens: 8000, model: 'anthropic/claude-sonnet-4-5' },
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

});

describe('checkCompactionInvariant', () => {
  it('passes when reserve + keepRecent < contextWindow', () => {
    const result = checkCompactionInvariant({ reserveTokens: 16000, keepRecentTokens: 20000 }, 200_000);
    expect(result.ok).toBe(true);
  });

  it('fails when reserve + keepRecent >= contextWindow', () => {
    const result = checkCompactionInvariant({ reserveTokens: 80_000, keepRecentTokens: 80_000 }, 128_000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Compaction invariant violated/);
    expect(result.error).toMatch(/128000/);
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
