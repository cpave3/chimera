import type { ModelLimits } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import {
  __resetContextWindowWarnings,
  CONTEXT_WINDOW_FALLBACK,
  resolveContextWindow,
  resolveModelWindows,
} from '../src/context-window';

describe('resolveContextWindow', () => {
  it('returns the override when one is provided in config', () => {
    __resetContextWindowWarnings();
    const warnings: string[] = [];
    const result = resolveContextWindow({
      providerShape: 'anthropic',
      providerId: 'anthropic',
      modelId: 'claude-opus-4-7',
      override: 1_000_000,
      warn: (m) => warnings.push(m),
    });
    expect(result).toEqual({ value: 1_000_000, source: 'override' });
    expect(warnings).toEqual([]);
  });

  it('returns the built-in window for a known model when no override is set', () => {
    __resetContextWindowWarnings();
    const result = resolveContextWindow({
      providerShape: 'anthropic',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
    expect(result.value).toBeGreaterThan(0);
    expect(result.value).not.toBe(CONTEXT_WINDOW_FALLBACK);
    expect(result.source).toBe('table');
  });

  it('falls back to the conservative default and warns once for unknown models', () => {
    __resetContextWindowWarnings();
    const warnings: string[] = [];
    const a = resolveContextWindow({
      providerShape: 'openai',
      providerId: 'local',
      modelId: 'some-experimental',
      warn: (m) => warnings.push(m),
    });
    const b = resolveContextWindow({
      providerShape: 'openai',
      providerId: 'local',
      modelId: 'some-experimental',
      warn: (m) => warnings.push(m),
    });
    expect(a).toEqual({ value: CONTEXT_WINDOW_FALLBACK, source: 'fallback' });
    expect(b).toEqual({ value: CONTEXT_WINDOW_FALLBACK, source: 'fallback' });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('local/some-experimental');
  });

  it('warns once per distinct model ref', () => {
    __resetContextWindowWarnings();
    const warnings: string[] = [];
    resolveContextWindow({
      providerShape: 'openai',
      providerId: 'local',
      modelId: 'mystery-a',
      warn: (m) => warnings.push(m),
    });
    resolveContextWindow({
      providerShape: 'openai',
      providerId: 'local',
      modelId: 'mystery-b',
      warn: (m) => warnings.push(m),
    });
    expect(warnings.length).toBe(2);
  });

  it('override beats both table and fallback', () => {
    __resetContextWindowWarnings();
    const result = resolveContextWindow({
      providerShape: 'openai',
      providerId: 'local',
      modelId: 'unknown',
      override: 500_000,
    });
    expect(result).toEqual({ value: 500_000, source: 'override' });
  });

  it('rejects non-positive overrides and ignores them', () => {
    __resetContextWindowWarnings();
    const result = resolveContextWindow({
      providerShape: 'anthropic',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      override: 0,
    });
    expect(result.source).toBe('table');
    expect(result.value).toBeGreaterThan(0);
  });

  it('discovered deployment context beats the built-in table', () => {
    __resetContextWindowWarnings();
    const result = resolveContextWindow({
      providerShape: 'anthropic',
      providerId: 'proxy',
      modelId: 'claude-sonnet-4-5',
      discovered: 300_000,
    });
    expect(result).toEqual({ value: 300_000, source: 'discovered' });
  });

  it('discovered context covers an unknown alias without the fallback warning', () => {
    __resetContextWindowWarnings();
    const warnings: string[] = [];
    const result = resolveContextWindow({
      providerShape: 'openai',
      providerId: 'manticore',
      modelId: 'glm-go',
      discovered: 1_000_000,
      warn: (m) => warnings.push(m),
    });
    expect(result).toEqual({ value: 1_000_000, source: 'discovered' });
    expect(warnings).toEqual([]);
  });

  it('an explicitly configured context override still beats discovery', () => {
    __resetContextWindowWarnings();
    const result = resolveContextWindow({
      providerShape: 'openai',
      providerId: 'manticore',
      modelId: 'glm-go',
      override: 128_000,
      discovered: 1_000_000,
    });
    expect(result).toEqual({ value: 128_000, source: 'override' });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    2 ** 53,
    Number.POSITIVE_INFINITY,
  ])('ignores an invalid discovered value of %s and keeps the legacy path', (invalid) => {
    __resetContextWindowWarnings();
    const warnings: string[] = [];
    const result = resolveContextWindow({
      providerShape: 'openai',
      providerId: 'manticore',
      modelId: 'glm-go',
      discovered: invalid,
      warn: (m) => warnings.push(m),
    });
    expect(result).toEqual({ value: CONTEXT_WINDOW_FALLBACK, source: 'fallback' });
    expect(warnings.length).toBe(1);
  });
});

describe('resolveModelWindows', () => {
  const limits = (over: Partial<ModelLimits>): ModelLimits =>
    ({
      context: { status: 'unknown' },
      input: { status: 'unknown' },
      output: { status: 'unknown' },
      ...over,
    }) as ModelLimits;

  it('resolves the prompt basis as the discovered input capped by the total context', () => {
    __resetContextWindowWarnings();
    const resolved = resolveModelWindows({
      providerShape: 'openai',
      providerId: 'manticore',
      modelId: 'glm-go',
      capabilities: {
        limits: limits({
          context: { status: 'discovered', value: 262_144 },
          input: { status: 'discovered', value: 131_072 },
          output: { status: 'discovered', value: 32_768 },
        }),
      },
    });
    expect(resolved.context).toEqual({ value: 262_144, source: 'discovered' });
    expect(resolved.inputLimit).toBe(131_072);
    expect(resolved.outputLimit).toBe(32_768);
    expect(resolved.promptBasis).toBe(131_072);
  });

  it('keeps the prompt basis at the total context when no input limit is discovered', () => {
    __resetContextWindowWarnings();
    const resolved = resolveModelWindows({
      providerShape: 'openai',
      providerId: 'manticore',
      modelId: 'glm-go',
      capabilities: { limits: limits({ context: { status: 'discovered', value: 262_144 } }) },
    });
    expect(resolved.inputLimit).toBeUndefined();
    expect(resolved.promptBasis).toBe(262_144);
  });

  it('clamps an oversized discovered input to the resolved context window', () => {
    __resetContextWindowWarnings();
    const resolved = resolveModelWindows({
      providerShape: 'anthropic',
      providerId: 'proxy',
      modelId: 'claude-sonnet-4-5',
      override: 200_000,
      capabilities: {
        limits: limits({ input: { status: 'discovered', value: 1_000_000 } }),
      },
    });
    expect(resolved.context).toEqual({ value: 200_000, source: 'override' });
    expect(resolved.promptBasis).toBe(200_000);
  });

  it('preserves legacy windows without capability metadata', () => {
    __resetContextWindowWarnings();
    const resolved = resolveModelWindows({
      providerShape: 'openai',
      providerId: 'local',
      modelId: 'some-experimental',
    });
    expect(resolved.context).toEqual({ value: CONTEXT_WINDOW_FALLBACK, source: 'fallback' });
    expect(resolved.inputLimit).toBeUndefined();
    expect(resolved.outputLimit).toBeUndefined();
    expect(resolved.promptBasis).toBe(CONTEXT_WINDOW_FALLBACK);
  });
});
