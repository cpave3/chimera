import type { Usage, UsageStep } from './types';

/**
 * Read a `LanguageModelUsage`-shaped value from a stream part. Returns
 * `undefined` when none of the numeric fields are present (provider didn't
 * report). A step that explicitly reports zeros is still a step.
 */
export function readStepUsage(raw: unknown): UsageStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cachedInputTokens?: unknown;
    totalTokens?: unknown;
    inputTokenDetails?: { cacheReadTokens?: unknown };
  };
  if (
    typeof r.inputTokens !== 'number' &&
    typeof r.outputTokens !== 'number' &&
    typeof r.totalTokens !== 'number'
  ) {
    return undefined;
  }
  const inputTokens = typeof r.inputTokens === 'number' ? r.inputTokens : 0;
  const outputTokens = typeof r.outputTokens === 'number' ? r.outputTokens : 0;
  // Prefer the canonical inputTokenDetails.cacheReadTokens; fall back to the
  // deprecated top-level cachedInputTokens for older provider shapes.
  const detailCacheRead = r.inputTokenDetails?.cacheReadTokens;
  const cachedInputTokens =
    typeof detailCacheRead === 'number'
      ? detailCacheRead
      : typeof r.cachedInputTokens === 'number'
        ? r.cachedInputTokens
        : 0;
  const totalTokens =
    typeof r.totalTokens === 'number'
      ? r.totalTokens
      : inputTokens + outputTokens;
  return { inputTokens, outputTokens, cachedInputTokens, totalTokens };
}

export function cloneUsage(u: Usage): Usage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cachedInputTokens: u.cachedInputTokens,
    totalTokens: u.totalTokens,
    stepCount: u.stepCount,
    lastStep: u.lastStep ? { ...u.lastStep } : undefined,
  };
}

/**
 * Apply a step's usage to a running session aggregate, in place. Returns the
 * updated aggregate (same reference) for chaining.
 */
export function applyStepUsage(usage: Usage, step: UsageStep): Usage {
  usage.inputTokens += step.inputTokens;
  usage.outputTokens += step.outputTokens;
  usage.cachedInputTokens += step.cachedInputTokens;
  usage.totalTokens += step.totalTokens;
  usage.stepCount += 1;
  usage.lastStep = { ...step };
  return usage;
}

/**
 * Reconcile a session aggregate against the AI SDK's terminal `totalUsage`
 * for the run. If `totalUsage.totalTokens` differs from `runDelta.totalTokens`
 * (the per-step accumulation for *this* run), adjust `usage` in place to
 * make the run's contribution match `totalUsage` and return `true`.
 *
 * Returns `false` when the two agree (or when `totalUsage` is missing), in
 * which case `usage` is untouched.
 */
export function reconcileFinalUsage(
  usage: Usage,
  runDelta: UsageStep,
  totalUsage: UsageStep | undefined,
): boolean {
  if (!totalUsage) return false;
  if (totalUsage.totalTokens === runDelta.totalTokens) return false;
  usage.inputTokens += totalUsage.inputTokens - runDelta.inputTokens;
  usage.outputTokens += totalUsage.outputTokens - runDelta.outputTokens;
  usage.cachedInputTokens +=
    totalUsage.cachedInputTokens - runDelta.cachedInputTokens;
  usage.totalTokens += totalUsage.totalTokens - runDelta.totalTokens;
  return true;
}
