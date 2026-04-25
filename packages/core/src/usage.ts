import type { Usage, UsageStep } from './types';

export function readStepUsage(raw: unknown): UsageStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cachedInputTokens?: unknown;
    totalTokens?: unknown;
    inputTokenDetails?: { cacheReadTokens?: unknown };
  };
  // A step counts as "no usage" only when no numeric field is present at all —
  // explicit zeros and cached-only payloads still count as a real step.
  if (
    typeof r.inputTokens !== 'number' &&
    typeof r.outputTokens !== 'number' &&
    typeof r.totalTokens !== 'number' &&
    typeof r.inputTokenDetails?.cacheReadTokens !== 'number'
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

// Mutates `usage` in place; returns the same reference for chaining.
export function applyStepUsage(usage: Usage, step: UsageStep): Usage {
  usage.inputTokens += step.inputTokens;
  usage.outputTokens += step.outputTokens;
  usage.cachedInputTokens += step.cachedInputTokens;
  usage.totalTokens += step.totalTokens;
  usage.stepCount += 1;
  usage.lastStep = { ...step };
  return usage;
}

// AI SDK's terminal `totalUsage` can disagree with per-step accumulation due
// to provider-side rounding; trust `totalUsage` when they diverge.
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
