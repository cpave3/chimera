import type { AgentEvent, CallId } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { Scrollback } from '../src/scrollback';
import { fakeSession, mountFullscreen, plain, settle } from './fullscreen-helpers';

const callId = 'CALL1' as CallId;
const bashStart: AgentEvent = {
  type: 'tool_call_start',
  callId,
  name: 'bash',
  args: { command: './dev check' },
  target: 'host',
  display: { summary: './dev check' },
};
const bashResult: AgentEvent = {
  type: 'tool_call_result',
  callId,
  result: { stdout: '', stderr: '', exit_code: 0, timed_out: false },
  durationMs: 40,
  display: { summary: './dev check (exit 0)' },
};
const checked = (
  over: Partial<Extract<AgentEvent, { type: 'system_one_checked' }>> = {},
): AgentEvent => ({
  type: 'system_one_checked',
  requestId: 'r1',
  callId,
  decision: 'allow',
  note: 'approved: safety 0.91, needs 0.80',
  safety: 0.91,
  threshold: 0.8,
  ...over,
});

describe('System One verdicts in the transcript', () => {
  it('marks the tool call the check approved, and no other', () => {
    const scrollback = new Scrollback();
    const other = 'CALL2' as CallId;
    scrollback.apply(bashStart);
    scrollback.apply({ ...bashStart, callId: other });
    scrollback.apply(checked());
    scrollback.apply(checked({ callId: other, decision: 'escalate' }));

    const tools = scrollback.all().filter((entry) => entry.kind === 'tool');

    expect(tools.map((entry) => entry.systemOneApproved === true)).toEqual([true, false]);
  });

  it('shows on the tool line that System One approved the call', async () => {
    const session = fakeSession();
    const { lastFrame, unmount } = mountFullscreen({}, session);
    for (const event of [bashStart, checked(), bashResult]) session.push(event);
    await settle(200);
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toMatch(/\.\/dev check \(exit 0\) · approved by System One/);
  });

  it('says in the prompt that the System One model rejected the command', async () => {
    const session = fakeSession();
    const { lastFrame, unmount } = mountFullscreen({}, session);
    session.push({
      type: 'permission_request',
      requestId: 'r1',
      tool: 'bash',
      target: 'host',
      command: 'vercel deploy --prod',
      systemOneNote: 'rejected: safety 0.31, needs 0.80, reads as "remote"',
    });
    await settle(200);
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('vercel deploy --prod');
    // The prompt wraps the note; its start is on one line.
    expect(frame).toContain('System One rejected: safety 0.31, needs 0.80');
  });
});
