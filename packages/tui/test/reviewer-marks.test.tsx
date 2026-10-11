import type { AgentEvent, CallId } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { Scrollback } from '../src/scrollback';
import { fakeSession, mountFullscreen, plain, settle } from './fullscreen-helpers';

const callId = 'CALL1' as CallId;
const bashStart: AgentEvent = {
  type: 'tool_call_start',
  callId,
  name: 'bash',
  args: { command: 'pnpm install' },
  target: 'host',
  display: { summary: 'pnpm install' },
};
const bashResult: AgentEvent = {
  type: 'tool_call_result',
  callId,
  result: { stdout: '', stderr: '', exit_code: 0, timed_out: false },
  durationMs: 40,
  display: { summary: 'pnpm install (exit 0)' },
};
const reviewed = (
  over: Partial<Extract<AgentEvent, { type: 'approval_reviewed' }>> = {},
): AgentEvent => ({
  type: 'approval_reviewed',
  requestId: 'r1',
  callId,
  decision: 'allow',
  reason: 'installs the dependencies of the task',
  ...over,
});

describe('reviewer decisions in the transcript', () => {
  it('marks the tool call the reviewer allowed, and no other', () => {
    const scrollback = new Scrollback();
    const other = 'CALL2' as CallId;
    scrollback.apply(bashStart);
    scrollback.apply({ ...bashStart, callId: other });
    scrollback.apply(reviewed());
    scrollback.apply(reviewed({ callId: other, decision: 'escalate' }));

    const tools = scrollback.all().filter((entry) => entry.kind === 'tool');

    expect(tools.map((entry) => entry.reviewerApproved === true)).toEqual([true, false]);
  });

  it('says once that the reviewer stopped', () => {
    const scrollback = new Scrollback();
    scrollback.apply(bashStart);
    scrollback.apply(reviewed({ decision: 'escalate', stopped: 'consecutive' }));

    const notices = scrollback.all().filter((entry) => entry.kind === 'info');

    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toMatch(/approval reviewer stopped for this session/);
    expect(notices[0]!.text).toMatch(/3 escalations in a row/);
  });

  it('shows on the tool line that the reviewer approved the call', async () => {
    const session = fakeSession();
    const { lastFrame, unmount } = mountFullscreen({}, session);
    for (const event of [bashStart, reviewed(), bashResult]) session.push(event);
    await settle(200);
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toMatch(/pnpm install \(exit 0\) · approved by reviewer/);
  });

  it('shows the reason of the reviewer in the prompt of an escalated request', async () => {
    const session = fakeSession();
    const { lastFrame, unmount } = mountFullscreen({}, session);
    session.push({
      type: 'permission_request',
      requestId: 'r1',
      tool: 'bash',
      target: 'host',
      command: 'git push origin main',
      reviewerReason: 'the user did not ask for a push',
    });
    await settle(200);
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('git push origin main');
    expect(frame).toContain('Reviewer: the user did not ask for a push');
  });
});
