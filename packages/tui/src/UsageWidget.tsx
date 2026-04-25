import { Text } from 'ink';
import React from 'react';
import type { Usage } from '@chimera/core';
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

export function UsageWidget(props: UsageWidgetProps): React.ReactElement {
  const theme = useTheme();
  const { usage, contextWindow, usedContextTokens, unknownWindow } = props;
  const pct =
    contextWindow > 0 ? Math.round((usedContextTokens / contextWindow) * 100) : null;
  const color = pickUsageColor(pct, theme);

  const used = formatTokens(usedContextTokens);
  const window = formatTokens(contextWindow);
  const delta = usage.lastStep ? `+${formatTokens(usage.lastStep.totalTokens)}` : '';
  const pctStr = pct === null ? '' : ` (${pct}%)`;
  const winStr = unknownWindow ? `${window}?` : window;
  const text =
    pct === null
      ? `${used} / —${delta ? ` ${delta}` : ''}`
      : `${used} / ${winStr}${pctStr}${delta ? ` ${delta}` : ''}`;
  return <Text color={color}>{text}</Text>;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${trim(Math.floor(n / 100) / 10)}k`;
  return `${trim(Math.floor(n / 10_000) / 100)}M`;
}

function trim(n: number): string {
  const s = n.toFixed(2);
  return s.replace(/\.?0+$/, '');
}
