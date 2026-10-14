import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeEvalHome } from '../src/home';
import { findVariant } from '../src/variants';

interface WrittenConfig {
  providers: Record<string, Record<string, unknown>>;
  models: Record<string, Record<string, unknown>>;
  commandPolicy: { hostBash: { osSandbox: string } };
  compaction: { reserveTokens: number; keepRecentTokens: number };
}

describe('writeEvalHome', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'chimera-evals-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function readConfig(): WrittenConfig {
    return JSON.parse(readFileSync(join(home, '.chimera', 'config.json'), 'utf8'));
  }

  it('points chimera at the local server and gives the model the profile of the variant', () => {
    const flags = writeEvalHome({
      home,
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'qwen/qwen3.5-9b',
      contextWindow: 32_768,
      variant: findVariant('lean'),
    });

    const config = readConfig();
    expect(config.providers['lm-studio']).toMatchObject({
      shape: 'openai',
      baseUrl: 'http://127.0.0.1:1234/v1',
    });
    expect(config.models['lm-studio/qwen/qwen3.5-9b']).toEqual({
      contextWindow: 32_768,
      promptStyle: 'lean',
    });
    expect(flags).toEqual(['--model', 'lm-studio/qwen/qwen3.5-9b']);
  });

  it('selects the adapter of a variant that names one', () => {
    writeEvalHome({
      home,
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'qwen/qwen3.5-9b',
      contextWindow: 32_768,
      variant: findVariant('compatible'),
    });

    expect(readConfig().providers['lm-studio']).toEqual({
      shape: 'openai',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      adapter: 'compatible',
    });
  });

  it('keeps every host command in the OS sandbox', () => {
    writeEvalHome({
      home,
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'qwen/qwen3.5-9b',
      contextWindow: 32_768,
      variant: findVariant('guided'),
    });

    expect(readConfig().commandPolicy.hostBash.osSandbox).toBe('required');
  });

  it.each([
    16_384, 32_768, 131_072,
  ])('fits the compaction budgets inside a %i-token context window', (contextWindow) => {
    writeEvalHome({
      home,
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'qwen/qwen3.5-9b',
      contextWindow,
      variant: findVariant('guided'),
    });

    const { reserveTokens, keepRecentTokens } = readConfig().compaction;
    expect(reserveTokens + keepRecentTokens).toBeLessThan(contextWindow / 2);
    expect(reserveTokens).toBeLessThanOrEqual(16_384);
    expect(keepRecentTokens).toBeLessThanOrEqual(20_000);
  });

  it('writes the mode of a variant that limits the tools, and selects it', () => {
    const flags = writeEvalHome({
      home,
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'google/gemma-4-12b-qat',
      contextWindow: 32_768,
      variant: findVariant('core-tools'),
    });

    const mode = readFileSync(join(home, '.chimera', 'modes', 'eval-core.md'), 'utf8');
    expect(mode).toContain('name: eval-core');
    expect(mode).toContain('tools: [read, edit, write, glob, grep, bash]');
    expect(flags).toEqual(expect.arrayContaining(['--mode', 'eval-core']));
  });
});

describe('findVariant', () => {
  it('names the known variants when the id is unknown', () => {
    expect(() => findVariant('nope')).toThrow(/Unknown variant "nope".*guided/);
  });
});
