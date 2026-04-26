import { describe, expect, it } from 'vitest';
import { loadProviders } from '../src/registry';

describe('loadProviders', () => {
  it('parses providerId/modelId and preserves nested slashes', () => {
    const registry = loadProviders({
      providers: {
        openrouter: {
          shape: 'openai',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'env:OPENROUTER_API_KEY',
        },
      },
    });
    const { provider, modelId } = registry.resolve('openrouter/anthropic/claude-opus-4');
    expect(provider.id).toBe('openrouter');
    expect(modelId).toBe('anthropic/claude-opus-4');
  });

  it('throws with configured providers listed when unknown providerId is used', () => {
    const registry = loadProviders({
      providers: {
        anthropic: { shape: 'anthropic', baseUrl: 'x', apiKey: 'env:A' },
      },
    });
    expect(() => registry.resolve('nonesuch/foo')).toThrow(/nonesuch/);
    expect(() => registry.resolve('nonesuch/foo')).toThrow(/anthropic/);
  });

  it('rejects modelRef without a slash', () => {
    const registry = loadProviders({ providers: {} });
    expect(() => registry.resolve('barebones')).toThrow(/providerId/);
  });

  it('resolves env: apiKey lazily at getModel() time', () => {
    process.env.TEST_KEY_PRESENT = 'secret-value';
    const registry = loadProviders({
      providers: {
        p: { shape: 'openai', baseUrl: 'https://x.test', apiKey: 'env:TEST_KEY_PRESENT' },
      },
    });
    const provider = registry.get('p');
    expect(() => provider.getModel('some-model')).not.toThrow();
    delete process.env.TEST_KEY_PRESENT;
  });

  it('throws at getModel() when env var is absent', () => {
    delete process.env.TEST_KEY_ABSENT;
    const registry = loadProviders({
      providers: {
        p: { shape: 'openai', baseUrl: 'https://x.test', apiKey: 'env:TEST_KEY_ABSENT' },
      },
    });
    expect(() => registry.get('p').getModel('m')).toThrow(/TEST_KEY_ABSENT/);
  });

  it('never includes the key value in error messages', () => {
    process.env.SECRET_MUST_NOT_LEAK = 'sk-xxx-zzz';
    const registry = loadProviders({
      providers: {
        p: { shape: 'openai', baseUrl: 'https://x.test', apiKey: 'env:OTHER_UNSET' },
      },
    });
    try {
      registry.get('p').getModel('m');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('sk-xxx-zzz');
    }
    delete process.env.SECRET_MUST_NOT_LEAK;
  });

  it('warns on plain-string keys but accepts them', () => {
    const warnings: string[] = [];
    const registry = loadProviders(
      {
        providers: {
          p: { shape: 'openai', baseUrl: 'https://x.test', apiKey: 'plaintext-key' },
        },
      },
      { warn: (m) => warnings.push(m) },
    );
    // Build the resolver via get (lazy).
    registry.get('p');
    expect(warnings.some((w) => /plain/i.test(w))).toBe(true);
  });
});
