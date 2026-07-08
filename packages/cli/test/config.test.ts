import { describe, expect, it } from 'vitest';
import { resolveModel } from '../src/config';

describe('resolveModel', () => {
  it('uses CLI model over config defaultModel', () => {
    const r = resolveModel({
      cliModel: 'openrouter/some-model',
      config: {
        defaultModel: 'anthropic/claude-opus-4-7',
        providers: {
          anthropic: { shape: 'anthropic', baseUrl: 'x', apiKey: 'env:A' },
          openrouter: { shape: 'openai', baseUrl: 'x', apiKey: 'env:O' },
        },
      },
    });
    expect(r.ref).toBe('openrouter/some-model');
    expect(r.model.providerId).toBe('openrouter');
    expect(r.model.modelId).toBe('some-model');
  });

  it('errors when no model is configured and no CLI override is given', () => {
    expect(() => resolveModel({ config: {} })).toThrow(/defaultModel/);
  });

  it('errors when the referenced provider is not configured', () => {
    expect(() =>
      resolveModel({
        cliModel: 'nonesuch/foo',
        config: { providers: { other: { shape: 'openai', baseUrl: 'x', apiKey: 'env:A' } } },
      }),
    ).toThrow(/nonesuch/);
  });

  it('defaults maxSteps to 100 when not specified', () => {
    const r = resolveModel({
      cliModel: 'anthropic/m',
      config: { providers: { anthropic: { shape: 'anthropic', baseUrl: 'x', apiKey: 'env:A' } } },
    });
    expect(r.model.maxSteps).toBe(100);
  });

  it('forwards models[ref].maxOutputTokens to ModelConfig', () => {
    const r = resolveModel({
      cliModel: 'synthetic/k',
      config: {
        providers: { synthetic: { shape: 'openai', baseUrl: 'x', apiKey: 'env:S' } },
        models: { 'synthetic/k': { maxOutputTokens: 32_768 } },
      },
    });
    expect(r.model.maxOutputTokens).toBe(32_768);
  });

  it('leaves maxOutputTokens undefined when not configured', () => {
    const r = resolveModel({
      cliModel: 'synthetic/k',
      config: {
        providers: { synthetic: { shape: 'openai', baseUrl: 'x', apiKey: 'env:S' } },
      },
    });
    expect(r.model.maxOutputTokens).toBeUndefined();
  });

  it('forwards models[ref].vision to ModelConfig and defaults it to undefined', () => {
    const providers = {
      synthetic: { shape: 'openai' as const, baseUrl: 'x', apiKey: 'env:S' },
    };
    const flagged = resolveModel({
      cliModel: 'synthetic/k',
      config: { providers, models: { 'synthetic/k': { vision: true } } },
    });
    expect(flagged.model.vision).toBe(true);

    const unflagged = resolveModel({
      cliModel: 'synthetic/k',
      config: { providers },
    });
    expect(unflagged.model.vision).toBeUndefined();
  });

  it('forwards models[ref].toolCallShape to ModelConfig and defaults it to undefined', () => {
    const providers = {
      synthetic: { shape: 'openai' as const, baseUrl: 'x', apiKey: 'env:S' },
    };
    const flagged = resolveModel({
      cliModel: 'synthetic/k',
      config: { providers, models: { 'synthetic/k': { toolCallShape: 'codex' } } },
    });
    expect(flagged.model.toolCallShape).toBe('codex');

    const unflagged = resolveModel({
      cliModel: 'synthetic/k',
      config: { providers },
    });
    expect(unflagged.model.toolCallShape).toBeUndefined();
  });
});
