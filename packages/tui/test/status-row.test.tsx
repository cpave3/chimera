import { homedir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '@chimera/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { BottomChrome, type BottomChromeProps } from '../src/BottomChrome';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { defaultTheme } from '../src/theme/tokens';

function footer(overrides: Partial<BottomChromeProps> = {}): string[] {
  const { lastFrame, unmount } = render(
    <ThemeProvider theme={defaultTheme}>
      <BottomChrome
        width={100}
        cwd={join(homedir(), 'Projects', 'chimera')}
        sessionId="01JABCDEFGH12345678"
        sandboxMode="off"
        activeModeName="build"
        pendingModeName={null}
        currentModelRef="anthropic/claude-opus-4-7"
        visionRouteRef={null}
        forked={false}
        running={false}
        tasks={[]}
        usageState={null}
        {...overrides}
      />
    </ThemeProvider>,
  );
  const frame = lastFrame() ?? '';
  unmount();
  return frame.split('\n');
}

function usage(inputTokens: number, cachedInputTokens: number, unknownWindow = false) {
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
    unknownWindow,
  };
}

const tasks = [
  { content: 'write failing test', status: 'completed' },
  { content: 'implement feature', status: 'in_progress' },
  { content: 'refactor', status: 'pending' },
];

describe('footer', () => {
  it('has two rows: what is running, and where', () => {
    const [state, place, ...rest] = footer();

    expect(rest).toEqual([]);
    expect(state).toContain('build');
    expect(state).toContain('anthropic/claude-opus-4-7');
    expect(state).toContain('sandbox off');
    expect(place).toContain('~/Projects/chimera');
    expect(place).toContain('session 12345678');
  });

  it('shows the context window as a gauge, a percentage and token counts', () => {
    const [state] = footer({ usageState: usage(84_000, 68_040) });

    expect(state).toContain('▰▰▰▰▱▱▱▱▱▱ 42%');
    expect(state).toContain('84k/200k');
    expect(state).toContain('cache 81%');
  });

  it('marks a context window whose size is an estimate', () => {
    const [state] = footer({ usageState: usage(84_000, 0, true) });

    expect(state).toContain('84k/200k?');
    expect(state).not.toContain('cache');
  });

  it('names the task in progress next to the working directory', () => {
    const [, place] = footer({ tasks });

    expect(place).toContain('tasks 1/3');
    expect(place).toContain('◼ implement feature');
  });

  it('says so when every task is done', () => {
    const done = tasks.map((task) => ({ ...task, status: 'completed' }));

    expect(footer({ tasks: done })[1]).toContain('tasks 3/3 ✔');
  });

  it('shows the key hints that fit the moment', () => {
    const idle = footer()[1]!;
    const running = footer({ running: true })[1]!;

    expect(idle).toContain('? help');
    expect(idle).toContain('/ commands');
    expect(running).toContain('esc interrupt');
    expect(running).toContain('enter steer');
    expect(running).toContain('tab queue');
    expect(running).not.toContain('/ commands');
  });

  it('shows a queued mode switch, a fork, and a vision-routed turn', () => {
    const [state] = footer({
      pendingModeName: 'plan',
      forked: true,
      visionRouteRef: 'manticore/kimi',
    });

    expect(state).toContain('build → plan');
    expect(state).toContain('forked');
    expect(state).toContain('→ manticore/kimi (vision)');
  });

  it('drops the least important items first on a narrow terminal', () => {
    const rows = footer({ width: 60, usageState: usage(84_000, 68_040), tasks, running: true });

    for (const row of rows) expect(row.length).toBeLessThanOrEqual(60);
    expect(rows[0]).toContain('build');
    expect(rows[0]).toContain('42%');
    expect(rows[0]).not.toContain('▰');
    expect(rows[1]).toContain('session 12345678');
  });

  it('shortens a long working directory from the left', () => {
    const [, place] = footer({
      width: 70,
      cwd: '/srv/workspaces/customer-portal/services/billing-reconciliation/worker',
    });

    expect(place).toContain('…');
    expect(place).toContain('billing-reconciliation/worker');
  });
});
