import { type AgentEvent, formatBackgroundAgentMessage } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { Scrollback } from '../src/scrollback';

const callId = 'call-1' as never;

const spawned: AgentEvent[] = [
  {
    type: 'tool_call_start',
    callId,
    name: 'spawn_agent',
    args: {},
    target: 'host',
    display: { summary: 'map the auth flow' },
  },
  {
    type: 'subagent_spawned',
    subagentId: 'a1',
    parentCallId: callId,
    childSessionId: 'child-1',
    url: 'http://127.0.0.1:1',
    purpose: 'map the auth flow',
    background: true,
  },
  {
    type: 'tool_call_result',
    callId,
    result: { subagent_id: 'a1', status: 'running' },
    durationMs: 10,
    display: { summary: 'map the auth flow (background)' },
  },
];

describe('a background subagent in the transcript', () => {
  it('adds nothing under the finished spawn line while the child works', () => {
    const scrollback = new Scrollback();
    for (const event of spawned) scrollback.apply(event);
    const before = scrollback.all().length;

    scrollback.apply({
      type: 'subagent_event',
      subagentId: 'a1',
      event: { type: 'assistant_text_done', text: 'looking at login.ts' },
    });
    scrollback.apply({
      type: 'subagent_event',
      subagentId: 'a1',
      event: {
        type: 'tool_call_start',
        callId: 'inner-1' as never,
        name: 'read',
        args: {},
        target: 'host',
      },
    });
    scrollback.apply({
      type: 'subagent_finished',
      subagentId: 'a1',
      parentCallId: callId,
      result: 'the answer',
      reason: 'stop',
    });

    expect(scrollback.all()).toHaveLength(before);
    expect(scrollback.all().map((entry) => entry.kind)).toEqual(['tool']);
  });

  it('shows the message of a child that ended as one line, not as something the user typed', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'user_message',
      content: formatBackgroundAgentMessage({
        id: 'a1',
        purpose: 'map the auth flow',
        state: 'done',
        answer: 'Login starts in src/auth/login.ts:42.\nMore lines here.',
      }),
    });

    const entries = scrollback.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'info',
      text: 'background agent done: map the auth flow',
    });
  });

  it('says so when the child failed', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'user_message',
      content: formatBackgroundAgentMessage({
        id: 'a1',
        purpose: 'run the audit',
        state: 'failed',
        answer: 'provider is down',
      }),
    });

    expect(scrollback.all()[0]).toMatchObject({
      kind: 'error',
      text: 'background agent failed: run the audit',
    });
  });
});
