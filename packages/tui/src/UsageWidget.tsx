import { Text } from 'ink';
import React from 'react';
import type { Usage } from '@chimera/core';
import { useTheme } from './theme/ThemeProvider';

export interface UsageWidgetProps {
  usage: Usage;
  contextWindow: number;
  usedContextTokens: number;
  /** True when contextWindow was resolved via the unknown-model fallback. */
  unknownWindow?: boolean;
}

/**
 * Render `<used> / <window> (<pct>%) +<delta>` in the right-hand status bar.
 * Color escalates as the percentage approaches the limit. Falls back to
 * `<used> / —` (no percentage, no color) when `contextWindow` is unknown.
 */
export function UsageWidget(props: UsageWidgetProps): React.ReactElement {
  const theme = useTheme();
  const { usage, contextWindow, usedContextTokens, unknownWindow } = props;
  const pct = contextWindow > 0 ? Math.round((usedContextTokens / contextWindow) * 100) : null;
  const color =
    pct === null
      ? theme.text.muted
      : pct >= 95
        ? theme.status.error
        : pct >= 80
          ? theme.status.warning
          : theme.text.muted;

  const used = formatTokens(usedContextTokens);
  const window = formatTokens(contextWindow);
  const delta = usage.lastStep ? `+${formatTokens(usage.lastStep.totalTokens)}` : '';
  const pctStr = pct === null ? '' : ` (${pct}%)`;
  const winStr = unknownWindow ? `${window}?` : window;
  const text = pct === null
    ? `${used} / —${delta ? ` ${delta}` : ''}`
    : `${used} / ${winStr}${pctStr}${delta ? ` ${delta}` : ''}`;
  return <Text color={color}>{text}</Text>;
}

/**
 * Format an integer token count as a short human-readable string:
 *   1_234       → "1.2k"
 *   12_345      → "12.3k"
 *   1_234_567   → "1.23M"
 * Numbers below 1000 render as-is. Always rounds down (so "remaining
 * budget" is never overstated).
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${trim((Math.floor(n / 100)) / 10)}k`;
  return `${trim((Math.floor(n / 10_000)) / 100)}M`;
}

function trim(n: number): string {
  // 1.0 → "1", 1.20 → "1.2", 1.23 → "1.23"
  const s = n.toFixed(2);
  return s.replace(/\.?0+$/, '');
}
