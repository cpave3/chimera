import type { Usage, UsageStep } from './types';

export function readStepUsage(raw: unknown): UsageStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usageObject = raw as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cachedInputTokens?: unknown;
    totalTokens?: unknown;
    inputTokenDetails?: { cacheReadTokens?: unknown };
  };
  // A step counts as "no usage" only when no numeric field is present at all —
  // explicit zeros and cached-only payloads still count as a real step.
  if (
    typeof usageObject.inputTokens !== 'number' &&
    typeof usageObject.outputTokens !== 'number' &&
    typeof usageObject.totalTokens !== 'number' &&
    typeof usageObject.inputTokenDetails?.cacheReadTokens !== 'number'
  ) {
    return undefined;
  }
  const inputTokens =
    typeof usageObject.inputTokens === 'number' ? usageObject.inputTokens : 0;
  const outputTokens =
    typeof usageObject.outputTokens === 'number' ? usageObject.outputTokens : 0;
  // Prefer the canonical inputTokenDetails.cacheReadTokens; fall back to the
  // deprecated top-level cachedInputTokens for older provider shapes.
  const detailCacheRead = usageObject.inputTokenDetails?.cacheReadTokens;
  const cachedInputTokens =
    typeof detailCacheRead === 'number'
      ? detailCacheRead
      : typeof usageObject.cachedInputTokens === 'number'
        ? usageObject.cachedInputTokens
        : 0;
  const totalTokens =
    typeof usageObject.totalTokens === 'number'
      ? usageObject.totalTokens
      : inputTokens + outputTokens;
  return { inputTokens, outputTokens, cachedInputTokens, totalTokens };
}

export function cloneUsage(usage: Usage): Usage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    totalTokens: usage.totalTokens,
    stepCount: usage.stepCount,
    lastStep: usage.lastStep ? { ...usage.lastStep } : undefined,
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
