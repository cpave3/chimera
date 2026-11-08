import { type AgentEvent, formatGoalMessage } from '@chimera/core';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import type { MountOptions } from '../src/mount';
import { fakeSession as inkSession, settle as inkSettle, plain } from './fullscreen-helpers';
import { fakeSession, type Mounted, mount } from './harness';

type GoalEvent = Extract<AgentEvent, { type: 'goal_updated' }>;

const goalEvent = (over: Partial<GoalEvent> & Pick<GoalEvent, 'change'>): GoalEvent => ({
  type: 'goal_updated',
  condition: 'all tests pass',
  ...over,
});

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** Mount on a client that records the goals the TUI sets, resuming a session with `current`. */
async function mountGoalSession(
  current: { condition: string } | null = null,
  overrides: Partial<MountOptions> = {},
) {
  const goals: Array<string | null> = [];
  const session = fakeSession();
  const client = session.client as unknown as Record<string, unknown>;
  client.setGoal = async (_sessionId: string, condition: string | null) => {
    goals.push(condition);
    return condition === null ? null : { condition };
  };
  client.getSession = async () => ({
    mode: 'build',
    model: { providerId: 'manticore', modelId: 'gpt' },
    messages: [],
    tasks: [],
    ...(current ? { goal: current } : {}),
  });
  mounted = await mount({ client: session.client, ...overrides });
  return { mounted, goals };
}

describe('/goal', () => {
  it('sets the goal of the session', async () => {
    const { mounted, goals } = await mountGoalSession();
    await mounted.keys('/goal all tests pass in packages/api\r');

    expect(goals).toEqual(['all tests pass in packages/api']);
  });

  it('clears the goal with "clear"', async () => {
    const { mounted, goals } = await mountGoalSession({ condition: 'all tests pass' });
    await mounted.keys('/goal clear\r');

    expect(goals).toEqual([null]);
  });

  it('shows the goal when it has no argument', async () => {
    const { mounted, goals } = await mountGoalSession({ condition: 'all tests pass' });
    await mounted.keys('/goal\r');

    expect(mounted.screen()).toContain('goal: all tests pass');
    expect(goals).toEqual([]);
  });

  it('says that there is no goal when none is set', async () => {
    const { mounted, goals } = await mountGoalSession();
    await mounted.keys('/goal\r');

    expect(mounted.screen()).toContain('no goal is set');
    expect(goals).toEqual([]);
  });
});

describe('the goal in the status line', () => {
  const statusLine = { rows: [{ left: ['goal'] }] };

  it('shows the goal while it is set, and drops it once it is met', async () => {
    mounted = await mount({ statusLine });
    await mounted.event(goalEvent({ change: 'set' }));
    expect(mounted.term.screen().at(-1)).toMatch(/^╰─ goal: all tests pass ─+╯$/);

    await mounted.event(goalEvent({ change: 'met', condition: null, reason: 'the run passed' }));
    expect(mounted.term.screen().at(-1)).not.toContain('goal:');
  });

  it('shows the goal of a resumed session', async () => {
    const { mounted } = await mountGoalSession({ condition: 'the build is green' }, { statusLine });

    expect(mounted.term.screen().at(-1)).toContain('goal: the build is green');
  });
});

describe('goal results in the transcript', () => {
  it('gives each change one row, a failed check as an error', async () => {
    mounted = await mount();
    await mounted.event(
      goalEvent({ change: 'set' }),
      goalEvent({
        change: 'not_met',
        reason: 'the tests were not run',
        continuation: 1,
        maxContinuations: 20,
      }),
      goalEvent({
        change: 'limit',
        reason: 'two tests still fail',
        continuation: 20,
        maxContinuations: 20,
      }),
      goalEvent({ change: 'unchecked', reason: 'the checker failed: 503' }),
      goalEvent({ change: 'impossible', condition: null, reason: 'no test command' }),
    );
    const screen = mounted.screen();

    expect(screen).toContain('   goal  goal set: all tests pass');
    expect(screen).toContain('   goal  goal not met (1 of 20): the tests were not run');
    expect(screen).toContain(
      '   goal  goal: limit of 20 continuations reached: two tests still fail',
    );
    expect(screen).toContain('✗ error  goal not checked: the checker failed: 503');
    expect(screen).toContain('✗ error  goal not possible: no test command');
  });

  it('breaks a long reason between words', async () => {
    const reason =
      'There are no tool calls or command outputs that show the last line of the notes file; run a command that prints the last line and read its output before you say that the work is done';
    mounted = await mount();
    await mounted.event(
      goalEvent({ change: 'not_met', reason, continuation: 1, maxContinuations: 20 }),
    );

    const rows = mounted.term.screen();
    const first = rows.findIndex((row) => row.includes('goal not met'));
    const last = rows.findIndex((row) => row.includes('the work is done'));
    const shown = rows
      .slice(first, last + 1)
      .map((row) => row.trim())
      .join(' ');
    expect(last).toBeGreaterThan(first);
    expect(shown).toBe(`goal  goal not met (1 of 20): ${reason}`);
  });

  it('says when the goal is met or cleared', async () => {
    mounted = await mount();
    await mounted.event(
      goalEvent({ change: 'met', condition: null, reason: 'the test run passed' }),
      goalEvent({ change: 'cleared', condition: null }),
    );

    expect(mounted.screen()).toContain('   goal  goal met: the test run passed');
    expect(mounted.screen()).toContain('   goal  goal cleared');
  });

  it('does not show the message to the agent as a message of the user', async () => {
    const message = formatGoalMessage({
      condition: 'all tests pass',
      reason: 'the tests were not run',
      continuation: 1,
      maxContinuations: 20,
    });
    mounted = await mount();
    await mounted.event(
      { type: 'user_message', content: 'make the tests pass' },
      { type: 'user_message', content: message },
    );
    const screen = mounted.screen();

    expect(screen).toContain('    you  make the tests pass');
    expect(screen).not.toContain('[goal check]');
    expect(screen).not.toContain('This message is from Chimera');
  });
});

describe('the goal in the inline layout', () => {
  it('is in the footer', async () => {
    const session = inkSession();
    const { lastFrame, unmount } = render(
      createElement(App, {
        client: session.client,
        sessionId: '01ABCDEFGH8AWWBRGC',
        modelRef: 'manticore/gpt',
        cwd: '/tmp/project',
        layout: 'inline',
        terminalSize: { columns: 100, rows: 30 },
        readWorktree: async () => null,
      }),
    );
    session.push(goalEvent({ change: 'set' }));
    await inkSettle(700);
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toMatch(/goal: all tests pass/);
  });
});
