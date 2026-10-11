import { type AgentEvent, formatGoalMessage } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import type { AppProps } from '../src/App';
import { fakeSession, mountFullscreen, plain, settle, type } from './fullscreen-helpers';

type GoalEvent = Extract<AgentEvent, { type: 'goal_updated' }>;

const goalEvent = (over: Partial<GoalEvent> & Pick<GoalEvent, 'change'>): GoalEvent => ({
  type: 'goal_updated',
  condition: 'all tests pass',
  ...over,
});

/** A session whose client records the goals the TUI sets. */
function goalSession(current: { condition: string } | null = null) {
  const session = fakeSession();
  const goals: Array<string | null> = [];
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
  return { session, goals };
}

async function screen(
  events: AgentEvent[],
  overrides: Partial<AppProps> = {},
  session = fakeSession(),
) {
  const { lastFrame, unmount } = mountFullscreen(overrides, session);
  for (const event of events) session.push(event);
  await settle(700);
  const rows = plain(lastFrame()).split('\n');
  unmount();
  return {
    // 100 columns: the panel takes the last 32.
    transcript: rows.map((row) => row.slice(0, 68).trimEnd()).join('\n'),
    panel: rows.map((row) => row.slice(68).trimEnd()).join('\n'),
    frame: rows.join('\n'),
  };
}

describe('/goal', () => {
  it('sets the goal of the session', async () => {
    const { session, goals } = goalSession();
    const { stdin, unmount } = mountFullscreen({}, session);
    await settle(100);

    await type(stdin, '/goal all tests pass in packages/api');
    stdin.write('\r');
    await settle(100);
    unmount();

    expect(goals).toEqual(['all tests pass in packages/api']);
  });

  it('clears the goal with "clear"', async () => {
    const { session, goals } = goalSession({ condition: 'all tests pass' });
    const { stdin, unmount } = mountFullscreen({}, session);
    await settle(100);

    await type(stdin, '/goal clear');
    stdin.write('\r');
    await settle(100);
    unmount();

    expect(goals).toEqual([null]);
  });

  it('shows the goal when it has no argument, or says that there is none', async () => {
    const withGoal = goalSession({ condition: 'all tests pass' });
    const mounted = mountFullscreen({}, withGoal.session);
    await settle(150);
    await type(mounted.stdin, '/goal');
    mounted.stdin.write('\r');
    await settle(150);
    const shown = plain(mounted.lastFrame());
    mounted.unmount();

    const without = goalSession();
    const empty = mountFullscreen({}, without.session);
    await settle(150);
    await type(empty.stdin, '/goal');
    empty.stdin.write('\r');
    await settle(150);
    const none = plain(empty.lastFrame());
    empty.unmount();

    expect(shown).toMatch(/goal: all tests pass/);
    expect(none).toMatch(/no goal is set/);
    expect([...withGoal.goals, ...without.goals]).toEqual([]);
  });
});

describe('the goal on the screen', () => {
  it('is a section of the context panel while it is set', async () => {
    const set = await screen([goalEvent({ change: 'set' })]);
    const met = await screen([
      goalEvent({ change: 'set' }),
      goalEvent({ change: 'met', condition: null, reason: 'the test run passed' }),
    ]);

    expect(set.panel).toContain('GOAL');
    expect(set.panel).toContain('all tests pass');
    expect(met.panel).not.toContain('GOAL');
  });

  it('is in the panel of a resumed session', async () => {
    const { session } = goalSession({ condition: 'the build is green' });

    const { panel } = await screen([], {}, session);

    expect(panel).toContain('GOAL');
    expect(panel).toContain('the build is green');
  });

  it('wraps a long condition in the panel and cuts it after three lines', async () => {
    const condition =
      'every package builds, every test passes, the linter reports no error, and the changelog names each change of this release';

    const { panel } = await screen([goalEvent({ change: 'set', condition })]);

    const section = panel.slice(panel.indexOf('GOAL')).split('\n').slice(1, 5);
    expect(section[0]).toContain('every package builds');
    expect(section[2]).toMatch(/…$/);
    expect(section[3]).toBe('');
  });

  it('is in the footer of the inline layout', async () => {
    const { frame } = await screen([goalEvent({ change: 'set' })], { layout: 'inline' });

    expect(frame).toMatch(/goal: all tests pass/);
  });
});

describe('goal results in the transcript', () => {
  it('gives each change one line', async () => {
    const { transcript } = await screen([
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
    ]);

    expect(transcript).toContain('goal set: all tests pass');
    expect(transcript).toContain('goal not met (1 of 20): the tests were not run');
    expect(transcript).toContain('goal: limit of 20 continuations reached: two tests still fail');
    expect(transcript).toContain('goal not checked: the checker failed: 503');
    expect(transcript).toContain('goal not possible: no test command');
  });

  it('breaks a long reason between words', async () => {
    const reason =
      'There are no tool calls or command outputs that show the last line of the notes file; run a command that prints the last line and read its output before you say that the work is done';

    const { transcript } = await screen([
      goalEvent({ change: 'not_met', reason, continuation: 1, maxContinuations: 20 }),
    ]);

    const lines = transcript.split('\n');
    const first = lines.findIndex((line) => line.includes('goal not met'));
    const last = lines.findIndex((line) => line.includes('the work is done'));
    const shown = lines
      .slice(first, last + 1)
      .map((line) => line.trim())
      .join(' ');
    expect(last).toBeGreaterThan(first);
    expect(shown).toBe(`goal not met (1 of 20): ${reason}`);
  });

  it('says when the goal is met or cleared', async () => {
    const { transcript } = await screen([
      goalEvent({ change: 'met', condition: null, reason: 'the test run passed' }),
      goalEvent({ change: 'cleared', condition: null }),
    ]);

    expect(transcript).toContain('goal met: the test run passed');
    expect(transcript).toContain('goal cleared');
  });

  it('does not show the message to the agent as a message of the user', async () => {
    const message = formatGoalMessage({
      condition: 'all tests pass',
      reason: 'the tests were not run',
      continuation: 1,
      maxContinuations: 20,
    });

    const { transcript } = await screen([
      { type: 'user_message', content: 'make the tests pass' },
      { type: 'user_message', content: message },
    ]);

    expect(transcript).toContain('make the tests pass');
    expect(transcript).not.toContain('[goal check]');
    expect(transcript).not.toContain('This message is from Chimera');
  });
});
