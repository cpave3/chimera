import { emptyUsage } from '@chimera/core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { BottomChrome, type BottomChromeProps } from '../src/BottomChrome';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { defaultTheme } from '../src/theme/tokens';

function statusRow(overrides: Partial<BottomChromeProps> = {}): string {
  const { lastFrame, unmount } = render(
    <ThemeProvider theme={defaultTheme}>
      <BottomChrome
        sandboxMode="off"
        activeModeName="build"
        pendingModeName={null}
        currentModelRef="anthropic/claude-opus-4-7"
        visionRouteRef={null}
        forked={false}
        tasks={[]}
        usageState={null}
        {...overrides}
      />
    </ThemeProvider>,
  );
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

function usage(inputTokens: number, cachedInputTokens: number) {
  return {
    usage: {
      ...emptyUsage(),
      lastStep: {
        inputTokens,
        outputTokens: 100,
        cachedInputTokens,
        totalTokens: inputTokens + 100,
      },
    },
    contextWindow: 200_000,
    usedContextTokens: inputTokens,
    unknownWindow: false,
  };
}

describe('status row', () => {
  it('is one row with the mode and the model, without brackets or key hints', () => {
    const row = statusRow();

    expect(row.split('\n')).toHaveLength(1);
    expect(row).toContain('build');
    expect(row).toContain('anthropic/claude-opus-4-7');
    expect(row).not.toMatch(/\[mode:|\[sandbox:/);
    expect(row).not.toContain('Ctrl+G');
    expect(row).toContain('? help');
  });

  it('shows context use and the cached share', () => {
    const row = statusRow({ usageState: usage(42_000, 33_600) });

    expect(row).toContain('ctx 21%');
    expect(row).toContain('cache 80%');
  });

  it('marks an approximate context window', () => {
    const row = statusRow({ usageState: { ...usage(42_000, 0), unknownWindow: true } });

    expect(row).toContain('ctx 21%?');
    expect(row).not.toContain('cache');
  });

  it('names the sandbox only when one is active', () => {
    expect(statusRow()).not.toContain('sandbox');
    expect(statusRow({ sandboxMode: 'overlay' })).toContain('sandbox overlay');
  });

  it('shows a queued mode switch', () => {
    expect(statusRow({ pendingModeName: 'plan' })).toContain('build → plan');
  });

  it('counts tasks on the right', () => {
    const row = statusRow({
      tasks: [
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'in_progress' },
        { content: 'three', status: 'pending' },
      ],
    });

    expect(row).toContain('tasks 1/3');
  });

  it('marks a forked session and a vision-routed turn', () => {
    const row = statusRow({ forked: true, visionRouteRef: 'manticore/kimi' });

    expect(row).toContain('forked');
    expect(row).toContain('→ manticore/kimi (vision)');
  });
});
