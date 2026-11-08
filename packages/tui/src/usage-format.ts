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
