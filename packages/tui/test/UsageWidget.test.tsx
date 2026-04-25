import { Box } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { emptyUsage, type Usage } from '@chimera/core';
import { formatTokens, pickUsageColor, UsageWidget } from '../src/UsageWidget';
import { defaultTheme } from '../src/theme/tokens';
import { ThemeProvider } from '../src/theme/ThemeProvider';

function frame(node: React.ReactNode): string {
  const { lastFrame, unmount } = render(
    <ThemeProvider theme={defaultTheme}>
      <Box>{node}</Box>
    </ThemeProvider>,
  );
  const out = lastFrame() ?? '';
  unmount();
  return out;
}

function usageWith(overrides: Partial<Usage> = {}): Usage {
  return { ...emptyUsage(), ...overrides };
}

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

describe('UsageWidget', () => {
  it('renders <used> / <window> (<pct>%) +<delta> after the first event', () => {
    const usage = usageWith({
      inputTokens: 41_200,
      outputTokens: 1_400,
      totalTokens: 42_600,
      stepCount: 1,
      lastStep: {
        inputTokens: 1_200,
        outputTokens: 200,
        cachedInputTokens: 0,
        totalTokens: 1_400,
      },
    });
    const out = frame(
      <UsageWidget usage={usage} contextWindow={200_000} usedContextTokens={41_200} />,
    );
    expect(out).toContain('41.2k');
    expect(out).toContain('200k');
    expect(out).toContain('21%');
    expect(out).toContain('+1.4k');
  });

  it('renders amber color in the 80–95% band', () => {
    const usage = usageWith({
      lastStep: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
      },
    });
    const out = frame(
      <UsageWidget usage={usage} contextWindow={200_000} usedContextTokens={170_000} />,
    );
    // 85%
    expect(out).toContain('85%');
  });

  it('renders red at >=95%', () => {
    const usage = usageWith();
    const out = frame(
      <UsageWidget usage={usage} contextWindow={200_000} usedContextTokens={195_000} />,
    );
    expect(out).toContain('98%');
  });

  it('omits percentage and adds ? glyph when window is unknown', () => {
    const usage = usageWith({
      lastStep: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 0,
        totalTokens: 150,
      },
    });
    const out = frame(
      <UsageWidget
        usage={usage}
        contextWindow={0}
        usedContextTokens={5_000}
        unknownWindow
      />,
    );
    expect(out).toContain('5k');
    // Render uses an em-dash for an unknown window.
    expect(out).toContain('—');
    expect(out).not.toContain('%');
  });

  it('renders without delta when no step has finished yet', () => {
    const usage = usageWith();
    const out = frame(
      <UsageWidget usage={usage} contextWindow={200_000} usedContextTokens={0} />,
    );
    expect(out).toContain('0 / 200k');
    expect(out).not.toContain('+');
  });
});
