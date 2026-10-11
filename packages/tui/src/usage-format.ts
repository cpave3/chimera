import type { Theme } from './theme/types';

/** The colour for a context-use figure: it escalates as the window fills. */
export function pickUsageColor(pct: number | null, theme: Theme): string {
  if (pct === null) return theme.text.muted;
  if (pct >= 95) return theme.status.error;
  if (pct >= 80) return theme.status.warning;
  return theme.text.muted;
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
