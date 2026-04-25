import { describe, expect, it } from 'vitest';
import { emptyUsage } from '../src/types';
import {
  applyStepUsage,
  cloneUsage,
  readStepUsage,
  reconcileFinalUsage,
} from '../src/usage';

describe('readStepUsage', () => {
  it('returns undefined for non-objects', () => {
    expect(readStepUsage(undefined)).toBeUndefined();
    expect(readStepUsage(null)).toBeUndefined();
    expect(readStepUsage(42)).toBeUndefined();
  });

  it('returns undefined when no numeric token fields are present', () => {
    expect(readStepUsage({})).toBeUndefined();
    expect(readStepUsage({ foo: 'bar' })).toBeUndefined();
  });

  it('treats a step with explicit zero counts as a real step', () => {
    expect(readStepUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }))
      .toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 });
  });

  it('infers totalTokens from input+output when missing', () => {
    expect(readStepUsage({ inputTokens: 100, outputTokens: 50 })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      totalTokens: 150,
    });
  });

  it('treats a cached-only payload as a real step', () => {
    expect(
      readStepUsage({ inputTokenDetails: { cacheReadTokens: 800 } }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 800,
      totalTokens: 0,
    });
  });

  it('reads cachedInputTokens from inputTokenDetails.cacheReadTokens when present', () => {
    expect(
      readStepUsage({
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        inputTokenDetails: { cacheReadTokens: 800 },
      }),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 800,
      totalTokens: 1200,
    });
  });

  it('falls back to deprecated top-level cachedInputTokens', () => {
    expect(
      readStepUsage({
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 800,
        totalTokens: 1200,
      }),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 800,
      totalTokens: 1200,
    });
  });
});

describe('applyStepUsage', () => {
  it('adds the step delta to a fresh aggregate', () => {
    const u = emptyUsage();
    applyStepUsage(u, {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 0,
      totalTokens: 1200,
    });
    expect(u).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 0,
      totalTokens: 1200,
      stepCount: 1,
      lastStep: {
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 0,
        totalTokens: 1200,
      },
    });
  });

  it('replaces lastStep on each call and accumulates totals', () => {
    const u = emptyUsage();
    applyStepUsage(u, {
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 0,
      totalTokens: 110,
    });
    applyStepUsage(u, {
      inputTokens: 200,
      outputTokens: 20,
      cachedInputTokens: 50,
      totalTokens: 220,
    });
    expect(u.totalTokens).toBe(330);
    expect(u.cachedInputTokens).toBe(50);
    expect(u.stepCount).toBe(2);
    expect(u.lastStep?.totalTokens).toBe(220);
  });
});

describe('reconcileFinalUsage', () => {
  it('returns false when totalUsage is undefined', () => {
    const u = emptyUsage();
    const before = cloneUsage(u);
    const changed = reconcileFinalUsage(
      u,
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
      undefined,
    );
    expect(changed).toBe(false);
    expect(u).toEqual(before);
  });

  it('returns false when totalUsage agrees with the run delta', () => {
    const u = emptyUsage();
    applyStepUsage(u, {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 0,
      totalTokens: 1200,
    });
    const before = cloneUsage(u);
    const runDelta = {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 0,
      totalTokens: 1200,
    };
    const total = {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 0,
      totalTokens: 1200,
    };
    expect(reconcileFinalUsage(u, runDelta, total)).toBe(false);
    expect(u).toEqual(before);
  });

  it('adjusts the aggregate when totalUsage exceeds the run delta', () => {
    const u = emptyUsage();
    applyStepUsage(u, {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 0,
      totalTokens: 1200,
    });
    const runDelta = {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 0,
      totalTokens: 1200,
    };
    const total = {
      inputTokens: 1010,
      outputTokens: 220,
      cachedInputTokens: 0,
      totalTokens: 1230,
    };
    expect(reconcileFinalUsage(u, runDelta, total)).toBe(true);
    expect(u.totalTokens).toBe(1230);
    expect(u.inputTokens).toBe(1010);
    expect(u.outputTokens).toBe(220);
  });

  it('preserves prior session totals; only the run delta is reconciled', () => {
    const u = emptyUsage();
    // Pretend the session already had 5000 tokens before this run.
    u.inputTokens = 4000;
    u.outputTokens = 1000;
    u.totalTokens = 5000;
    u.stepCount = 3;
    // This run added 1200; totalUsage says 1230.
    applyStepUsage(u, {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 0,
      totalTokens: 1200,
    });
    const runDelta = {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 0,
      totalTokens: 1200,
    };
    const total = {
      inputTokens: 1010,
      outputTokens: 220,
      cachedInputTokens: 0,
      totalTokens: 1230,
    };
    reconcileFinalUsage(u, runDelta, total);
    expect(u.totalTokens).toBe(6230); // 5000 + 1230
    expect(u.inputTokens).toBe(5010); // 4000 + 1010
  });
});
