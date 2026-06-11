import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { ContextTracker, estimateTokens, shouldCompact } from '../src/context-tracker';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });

describe('ContextTracker', () => {
  it('bootstraps in estimate mode before any usage data', () => {
    const tracker = new ContextTracker();
    const messages = [user('x'.repeat(400))];
    expect(tracker.projectedNextPrompt(messages)).toBe(estimateTokens(messages));
  });

  it('projects real usage plus the estimated delta once usage lands', () => {
    const tracker = new ContextTracker();
    const messages = [user('a'.repeat(400)), user('b'.repeat(400))];
    tracker.noteUsage(50_000, 2);
    const grown = [...messages, user('c'.repeat(400))];
    expect(tracker.projectedNextPrompt(grown)).toBe(50_000 + estimateTokens(grown.slice(2)));
  });

  it('falls back to estimate mode after noteCompaction until fresh usage arrives', () => {
    const tracker = new ContextTracker();
    tracker.noteUsage(50_000, 2);
    tracker.noteCompaction();
    const compacted = [user('summary'), user('tail')];
    expect(tracker.projectedNextPrompt(compacted)).toBe(estimateTokens(compacted));

    tracker.noteUsage(3_000, 2);
    const grown = [...compacted, user('next')];
    expect(tracker.projectedNextPrompt(grown)).toBe(3_000 + estimateTokens(grown.slice(2)));
  });

  it('treats a shrunken message array as stale (external mutation)', () => {
    const tracker = new ContextTracker();
    tracker.noteUsage(50_000, 10);
    const fewer = [user('only one left')];
    expect(tracker.projectedNextPrompt(fewer)).toBe(estimateTokens(fewer));
  });
});

describe('shouldCompact', () => {
  const base = {
    contextWindow: 200_000,
    thresholdPercent: 85,
    reserveTokens: 16_384,
  };

  it('triggers above the percentage threshold', () => {
    expect(shouldCompact({ ...base, projected: 171_000 })).toBe(true);
    expect(shouldCompact({ ...base, projected: 169_000 })).toBe(false);
  });

  it('uses the absolute reserve when it is the tighter bound', () => {
    // window 100k, 85% = 85k; reserve floor max(16384, 8192+4096=12288) =
    // 16384 → 100k - 16384 = 83616 is tighter than 85k.
    const small = { contextWindow: 100_000, thresholdPercent: 85, reserveTokens: 16_384 };
    expect(shouldCompact({ ...small, projected: 84_000 })).toBe(true);
    expect(shouldCompact({ ...small, projected: 83_000 })).toBe(false);
  });

  it('grows the reserve to cover large maxOutputTokens', () => {
    // reserve = max(16384, 64000 + 4096) = 68096 → trigger at 131904.
    const result = shouldCompact({
      ...base,
      projected: 140_000,
      maxOutputTokens: 64_000,
    });
    expect(result).toBe(true);
    expect(shouldCompact({ ...base, projected: 130_000, maxOutputTokens: 64_000 })).toBe(false);
  });
});
