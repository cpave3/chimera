import { describe, expect, it } from 'vitest';
import { formatTokens } from '../src/usage-format';

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
