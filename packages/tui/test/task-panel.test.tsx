import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { planLiveRegion } from '../src/live-region';
import { TaskPanel } from '../src/TaskPanel';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { defaultTheme } from '../src/theme/tokens';

type Task = { content: string; status: string };

function panel(tasks: Task[], maxLines = 6): string {
  const { lastFrame, unmount } = render(
    <ThemeProvider theme={defaultTheme}>
      <TaskPanel tasks={tasks} maxLines={maxLines} />
    </ThemeProvider>,
  );
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

const tasks: Task[] = [
  { content: 'Classify provider errors', status: 'completed' },
  { content: 'Add the backoff loop', status: 'completed' },
  { content: 'Add a test for mid-stream errors', status: 'in_progress' },
  { content: 'Update README', status: 'pending' },
  { content: 'Run the full suite', status: 'pending' },
];

describe('task panel', () => {
  it('shows the count and starts at the task in progress', () => {
    const lines = panel(tasks).split('\n');

    expect(lines[0]).toContain('tasks 2/5');
    expect(lines[1]).toContain('◼ Add a test for mid-stream errors');
    expect(lines[2]).toContain('◻ Update README');
    expect(lines[3]).toContain('◻ Run the full suite');
    expect(lines).toHaveLength(4);
  });

  it('never takes more than its line budget and says how many tasks are hidden', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      content: `task ${i + 1}`,
      status: 'pending',
    }));

    const lines = panel(many).split('\n');

    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain('◻ task 1');
    expect(lines[5]).toContain('… 16 more');
  });

  it('shows finished tasks once everything is done', () => {
    const done = tasks.map((task) => ({ ...task, status: 'completed' }));

    const out = panel(done);

    expect(out).toContain('tasks 5/5');
    expect(out).toContain('✔ Classify provider errors');
  });

  it('renders nothing without room or without tasks', () => {
    expect(panel(tasks, 1)).toBe('');
    expect(panel([])).toBe('');
  });
});

describe('planLiveRegion', () => {
  const base = {
    rows: 24,
    promptLines: 1,
    taskCount: 0,
    queuedCount: 0,
    helpOpen: false,
    modalOpen: false,
  };

  it('keeps the redrawn region below the terminal height with many tasks and queued messages', () => {
    const plan = planLiveRegion({ ...base, taskCount: 20, queuedCount: 5 });

    expect(plan.queuedLines).toBe(3);
    expect(plan.taskLines).toBeGreaterThanOrEqual(2);
    expect(plan.taskLines).toBeLessThanOrEqual(6);
    expect(plan.reservedLines + plan.queuedLines + plan.taskLines).toBeLessThan(24);
  });

  it('gives the task panel its full six lines on a tall terminal', () => {
    expect(planLiveRegion({ ...base, rows: 50, taskCount: 20 }).taskLines).toBe(6);
  });

  it('drops the task panel on a terminal too short for it', () => {
    expect(planLiveRegion({ ...base, rows: 16, taskCount: 20 }).taskLines).toBe(0);
  });

  it('gives the room to an open modal or help panel instead', () => {
    expect(planLiveRegion({ ...base, taskCount: 20, modalOpen: true }).taskLines).toBe(0);
    expect(planLiveRegion({ ...base, taskCount: 20, helpOpen: true }).taskLines).toBe(0);
  });
});
