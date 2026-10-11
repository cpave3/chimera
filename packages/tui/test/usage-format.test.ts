import { describe, expect, it } from 'vitest';
import { defaultTheme } from '../src/theme/tokens';
import { formatTokens, pickUsageColor } from '../src/usage-format';

describe('formatTokens', () => {
  it('renders sub-thousand counts as integers', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });
  it('uses k suffix in thousands with one decimal', () => {
    expect(formatTokens(1_234)).toBe('1.2k');
    expect(formatTokens(41_234)).toBe('41.2k');
  });
  it('uses M suffix in millions with two decimals', () => {
    expect(formatTokens(1_234_567)).toBe('1.23M');
  });
  it('trims trailing zeros', () => {
    expect(formatTokens(1_000)).toBe('1k');
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });
});

describe('pickUsageColor', () => {
  it('returns muted under the warning threshold', () => {
    expect(pickUsageColor(0, defaultTheme)).toBe(defaultTheme.text.muted);
    expect(pickUsageColor(50, defaultTheme)).toBe(defaultTheme.text.muted);
    expect(pickUsageColor(79, defaultTheme)).toBe(defaultTheme.text.muted);
  });
  it('returns warning between 80 and 95', () => {
    expect(pickUsageColor(80, defaultTheme)).toBe(defaultTheme.status.warning);
    expect(pickUsageColor(94, defaultTheme)).toBe(defaultTheme.status.warning);
  });
  it('returns error at 95 or above', () => {
    expect(pickUsageColor(95, defaultTheme)).toBe(defaultTheme.status.error);
    expect(pickUsageColor(100, defaultTheme)).toBe(defaultTheme.status.error);
  });
  it('returns muted when pct is null (unknown window)', () => {
    expect(pickUsageColor(null, defaultTheme)).toBe(defaultTheme.text.muted);
  });
});
