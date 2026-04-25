import { describe, expect, it } from 'vitest';
import {
  CONTEXT_WINDOW_FALLBACK,
  resolveContextWindow,
  __resetContextWindowWarnings,
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
    expect(result).toBe(1_000_000);
    expect(warnings).toEqual([]);
  });

  it('returns the built-in window for a known model when no override is set', () => {
    __resetContextWindowWarnings();
    const result = resolveContextWindow({
      providerShape: 'anthropic',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
    expect(result).toBeGreaterThan(0);
    expect(result).not.toBe(CONTEXT_WINDOW_FALLBACK);
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
    expect(a).toBe(CONTEXT_WINDOW_FALLBACK);
    expect(b).toBe(CONTEXT_WINDOW_FALLBACK);
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
    expect(result).toBe(500_000);
  });

  it('rejects non-positive overrides and ignores them', () => {
    __resetContextWindowWarnings();
    const result = resolveContextWindow({
      providerShape: 'anthropic',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      override: 0,
    });
    // Override is invalid, so falls through to table.
    expect(result).toBeGreaterThan(0);
  });
});
