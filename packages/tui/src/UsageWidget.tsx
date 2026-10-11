import type { Usage } from '@chimera/core';
import { Text } from 'ink';
import React, { memo } from 'react';
import { useTheme } from './theme/ThemeProvider';
import type { Theme } from './theme/types';

export interface UsageWidgetProps {
  usage: Usage;
  contextWindow: number;
  usedContextTokens: number;
  /** True when contextWindow was resolved via the unknown-model fallback. */
  unknownWindow?: boolean;
}

export function pickUsageColor(pct: number | null, theme: Theme): string {
  if (pct === null) return theme.text.muted;
  if (pct >= 95) return theme.status.error;
  if (pct >= 80) return theme.status.warning;
  return theme.text.muted;
}

function sameUsageStep(
  a: NonNullable<Usage['lastStep']>,
  b: NonNullable<Usage['lastStep']>,
): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.totalTokens === b.totalTokens
  );
}

export function sameUsage(a: Usage, b: Usage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.totalTokens === b.totalTokens &&
    a.stepCount === b.stepCount &&
    (a.lastStep == null
      ? b.lastStep == null
      : b.lastStep != null && sameUsageStep(a.lastStep, b.lastStep))
  );
}

/**
 * How full the context window is, and how much of the last prompt the
 * provider served from its cache. Absolute numbers are in `/context`.
 */
export const UsageWidget = memo(function UsageWidget(props: UsageWidgetProps): React.ReactElement {
  const theme = useTheme();
  const { usage, contextWindow, usedContextTokens, unknownWindow } = props;
  const pct = contextWindow > 0 ? Math.round((usedContextTokens / contextWindow) * 100) : null;
  const context =
    pct === null ? formatTokens(usedContextTokens) : `${pct}%${unknownWindow ? '?' : ''}`;
  const cacheShare = formatCacheShare(usage.lastStep);
  return (
    <Text>
      <Text color={pickUsageColor(pct, theme)}>{`ctx ${context}`}</Text>
      {cacheShare && <Text color={theme.text.muted}>{` · ${cacheShare}`}</Text>}
    </Text>
  );
}, arePropsEqual);

function arePropsEqual(prev: UsageWidgetProps, next: UsageWidgetProps): boolean {
  return (
    prev.contextWindow === next.contextWindow &&
    prev.usedContextTokens === next.usedContextTokens &&
    prev.unknownWindow === next.unknownWindow &&
    sameUsage(prev.usage, next.usage)
  );
}

/** Share of the last prompt the provider served from its prompt cache. */
function formatCacheShare(lastStep: Usage['lastStep']): string {
  if (!lastStep || lastStep.inputTokens <= 0 || lastStep.cachedInputTokens <= 0) return '';
  const share = Math.min(
    100,
    Math.round((lastStep.cachedInputTokens / lastStep.inputTokens) * 100),
  );
  return `cache ${share}%`;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${trim(Math.floor(n / 100) / 10)}k`;
  return `${trim(Math.floor(n / 10_000) / 100)}M`;
}

function trim(n: number): string {
  const fixed = n.toFixed(2);
  return fixed.replace(/\.?0+$/, '');
}
