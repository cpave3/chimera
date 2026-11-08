import type { AgentEvent, CallId } from '@chimera/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Scrollback } from '../src/scrollback';
import { type Mounted, mount } from './harness';

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

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
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

  it('shows on the tool row that System One approved the call', async () => {
    mounted = await mount();
    await mounted.event(bashStart, checked(), bashResult);

    expect(mounted.screen()).toMatch(/ {3}bash {2}\.\/dev check {2}0\.0s · approved by System One/);
  });

  it('says in the card that the System One model rejected the command', async () => {
    mounted = await mount();
    await mounted.event({
      type: 'permission_request',
      requestId: 'r1',
      tool: 'bash',
      target: 'host',
      command: 'vercel deploy --prod',
      systemOneNote: 'rejected: safety 0.31, needs 0.80, reads as "remote"',
    });
    const screen = mounted.screen();

    expect(screen).toContain('bash   vercel deploy --prod');
    expect(screen).toContain('check  System One rejected: safety 0.31, needs 0.80');
  });
});
