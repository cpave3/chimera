import type { AgentEvent } from '@chimera/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import {
  type FakeSession,
  fakeSession,
  mountFullscreen,
  plain,
  settle,
} from './fullscreen-helpers';

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';

/** A command of `count` numbered lines: far taller than the 30-row test screen. */
function longCommand(count: number): string {
  return Array.from({ length: count }, (_, index) => `echo step ${index + 1} of ${count};`).join(
    '\n',
  );
}

type PolicyAnalysis = Extract<AgentEvent, { type: 'permission_request' }>['policyAnalysis'];

const SANDBOX_BYPASS: PolicyAnalysis = {
  version: 1,
  outcome: 'approval_required',
  stages: [],
  findings: [
    {
      kind: 'elevation',
      stageId: 'os_sandbox',
      ruleId: 'unsandboxed',
      message: 'Bypass requested',
    },
  ],
};

function requestPermission(
  session: FakeSession,
  command: string,
  policyAnalysis?: PolicyAnalysis,
): void {
  session.push({
    type: 'permission_request',
    requestId: 'r1',
    tool: 'bash',
    target: 'host',
    command,
    policyAnalysis,
  } as AgentEvent);
}

describe('a permission prompt taller than the screen', () => {
  it('keeps the choices on screen', async () => {
    const { lastFrame, unmount, session } = mountFullscreen();
    requestPermission(session, longCommand(60));
    await settle(80);
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('Permission required');
    expect(frame).toContain('echo step 1 of 60;');
    expect(frame).toMatch(/› 1\. Allow once/);
    expect(frame).toContain('Deny with feedback');
    expect(frame).toContain('message chimera');
  });

  it('scrolls the request with PageDown and PageUp, under choices that stay put', async () => {
    const { lastFrame, unmount, session, stdin } = mountFullscreen();
    requestPermission(session, longCommand(60));
    await settle(80);
    stdin.write(PAGE_DOWN);
    await settle();
    const lower = plain(lastFrame());
    stdin.write(PAGE_UP);
    await settle();
    const upper = plain(lastFrame());
    unmount();

    expect(lower).not.toContain('echo step 1 of 60;');
    expect(lower).toMatch(/echo step 1\d of 60;/);
    expect(lower).toMatch(/› 1\. Allow once/);
    expect(upper).toContain('Permission required');
    expect(upper).toContain('echo step 1 of 60;');
  });

  it('scrolls the request three lines for one notch of the wheel', async () => {
    const { lastFrame, unmount, session, mouse } = mountFullscreen();
    requestPermission(session, longCommand(60));
    await settle(80);
    mouse.emit({ kind: 'wheel-down' });
    await settle();
    const frame = plain(lastFrame());
    unmount();

    // The title, the "Run on the HOST" line and the first step go off the top.
    expect(frame).not.toContain('echo step 1 of 60;');
    expect(frame).toContain('echo step 2 of 60;');
    expect(frame).toMatch(/› 1\. Allow once/);
  });

  it('keeps the question of the remember step on screen', async () => {
    const { lastFrame, unmount, session, stdin } = mountFullscreen();
    requestPermission(session, longCommand(60), SANDBOX_BYPASS);
    await settle(80);
    stdin.write('A');
    await settle();
    const frame = plain(lastFrame());
    stdin.write(PAGE_DOWN);
    await settle();
    const lower = plain(lastFrame());
    unmount();

    expect(frame).toContain('exact: echo step 1 of 60;');
    expect(frame).toContain('Remember for [s]ession, [p]roject, or [g]lobal?');
    expect(frame).toContain('message chimera');
    expect(lower).not.toContain('echo step 1 of 60;');
    expect(lower).toContain('Remember for [s]ession, [p]roject, or [g]lobal?');
  });

  it('shows the end of a pattern being edited, under its label', async () => {
    const { lastFrame, unmount, session, stdin } = mountFullscreen();
    requestPermission(session, longCommand(60));
    await settle(80);
    stdin.write('g');
    await settle();
    stdin.write('!');
    await settle();
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('Edit pattern (Enter to confirm):');
    expect(frame).toContain('echo step 60 of 60;!');
    expect(frame).toContain('message chimera');
  });

  it('says which lines are in view and how to scroll', async () => {
    const { lastFrame, unmount, session, stdin } = mountFullscreen();
    requestPermission(session, longCommand(60));
    await settle(80);
    const top = plain(lastFrame());
    stdin.write(PAGE_DOWN);
    await settle();
    const lower = plain(lastFrame());
    unmount();

    // The title, the "Run on the HOST" line and the sixty lines of the command.
    expect(top).toMatch(/lines 1–\d+ of 62 · pgup\/pgdn scroll/);
    expect(lower).toMatch(/lines [1-9]\d*–\d+ of 62 · pgup\/pgdn scroll/);
    expect(lower).not.toMatch(/lines 1–/);
  });

  it('says nothing about scrolling when the whole prompt fits', async () => {
    const { lastFrame, unmount, session } = mountFullscreen();
    requestPermission(session, longCommand(3));
    await settle(80);
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('echo step 3 of 3;');
    expect(frame).not.toContain('pgup/pgdn');
  });
});

describe('a permission prompt taller than the terminal, in the inline layout', () => {
  const ROWS = 40;

  function mountInline() {
    const session = fakeSession();
    const rendered = render(
      <App
        client={session.client}
        sessionId="01ABCDEFGH8AWWBRGC"
        modelRef="manticore/gpt"
        cwd="/tmp/project"
        terminalSize={{ columns: 100, rows: ROWS }}
      />,
    );
    return { ...rendered, session };
  }

  /** The rows of the frame that a terminal of `ROWS` rows still shows. */
  function onScreen(frame: string | undefined): string {
    return [...plain(frame).split('\n'), ''].slice(-ROWS).join('\n');
  }

  it('shows the whole prompt on one screen and scrolls the request', async () => {
    const { lastFrame, unmount, session, stdin } = mountInline();
    requestPermission(session, longCommand(60));
    await settle(80);
    const top = onScreen(lastFrame());
    stdin.write(PAGE_DOWN);
    await settle();
    const lower = onScreen(lastFrame());
    unmount();

    expect(top).toContain('Permission required');
    expect(top).toContain('echo step 1 of 60;');
    expect(top).toMatch(/› 1\. Allow once/);
    expect(top).toMatch(/lines 1–\d+ of 62 · pgup\/pgdn scroll/);
    expect(lower).not.toContain('echo step 1 of 60;');
    expect(lower).toMatch(/echo step [23]\d of 60;/);
    expect(lower).toMatch(/› 1\. Allow once/);
  });
});
