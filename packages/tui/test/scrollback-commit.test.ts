import { describe, expect, it } from 'vitest';
import { Scrollback, type ScrollbackEntry } from '../src/scrollback';

function committedIds(scrollback: Scrollback): string[] {
  const { entries, committedCount } = scrollback.splitSnapshot();
  return entries.slice(0, committedCount).map((entry) => entry.id);
}

function expectPrefix(previous: string[], next: string[]): void {
  expect(next.slice(0, previous.length)).toEqual(previous);
}

describe('Scrollback commit cursor', () => {
  it('keeps the committed prefix append-only when tool results arrive out of order', () => {
    const scrollback = new Scrollback();
    const snapshots: string[][] = [];
    const record = () => snapshots.push(committedIds(scrollback));

    scrollback.apply({ type: 'user_message', content: 'do two things' });
    record();
    scrollback.apply({ type: 'tool_call_start', callId: 'a', name: 'bash', args: {}, target: 'host' });
    scrollback.apply({ type: 'tool_call_start', callId: 'b', name: 'read', args: {}, target: 'host' });
    record();
    // B finishes before A — must NOT commit ahead of the still-pending A.
    scrollback.apply({ type: 'tool_call_result', callId: 'b', result: {}, durationMs: 1 });
    record();
    scrollback.apply({ type: 'tool_call_result', callId: 'a', result: {}, durationMs: 1 });
    record();

    for (let i = 1; i < snapshots.length; i++) {
      expectPrefix(snapshots[i - 1]!, snapshots[i]!);
    }
    // After both resolve, everything is committed in entry order.
    const { entries, committedCount } = scrollback.splitSnapshot();
    expect(committedCount).toBe(entries.length);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'tool', 'tool']);
  });

  it('never commits the assistant entry while it is still streaming', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'partial ' });
    let split = scrollback.splitSnapshot();
    expect(split.committedCount).toBe(0);

    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'text' });
    split = scrollback.splitSnapshot();
    expect(split.committedCount).toBe(0);

    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'partial text' });
    split = scrollback.splitSnapshot();
    expect(split.committedCount).toBe(1);
    expect(split.entries[0]!.text).toBe('partial text');
  });

  it('blocks instantly-final entries behind a streaming assistant entry', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'thinking about it' });
    scrollback.addInfo('background process shell_1 exited');
    // The info entry is final but must wait for the streamer ahead of it.
    expect(scrollback.splitSnapshot().committedCount).toBe(0);

    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'thinking about it' });
    const { entries, committedCount } = scrollback.splitSnapshot();
    expect(committedCount).toBe(2);
    expect(entries.map((e) => e.kind)).toEqual(['assistant', 'info']);
  });

  it('keeps a trailing mode_change uncommitted until another entry lands', () => {
    const scrollback = new Scrollback();
    scrollback.addModeChange('build', 'plan');
    expect(scrollback.splitSnapshot().committedCount).toBe(0);

    // Collapses into the same trailing row — still uncommitted.
    scrollback.addModeChange('plan', 'question');
    expect(scrollback.splitSnapshot().committedCount).toBe(0);
    expect(scrollback.splitSnapshot().entries).toHaveLength(1);

    scrollback.addInfo('something else');
    const { entries, committedCount } = scrollback.splitSnapshot();
    expect(committedCount).toBe(2);
    expect(entries[0]!.kind).toBe('mode_change');
  });

  it('run_finished finalizes dangling streaming and pending-tool state', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'interrupted mid-' });
    scrollback.apply({ type: 'tool_call_start', callId: 'a', name: 'bash', args: {}, target: 'host' });
    expect(scrollback.splitSnapshot().committedCount).toBe(0);

    scrollback.apply({ type: 'run_finished', reason: 'interrupted' });
    const { entries, committedCount } = scrollback.splitSnapshot();
    // Both entries unblock: the partial text stays visible, the tool is
    // marked errored, and the committed prefix covers everything.
    expect(committedCount).toBe(entries.length);
    expect(entries.filter((e) => e.kind === 'assistant')[0]!.text).toBe('interrupted mid-');
  });

  it('property: committed prefix is monotonic across a mixed interleaving', () => {
    const scrollback = new Scrollback();
    const snapshots: string[][] = [];
    const record = () => snapshots.push(committedIds(scrollback));

    const events: Parameters<Scrollback['apply']>[0][] = [
      { type: 'user_message', content: 'go' },
      { type: 'reasoning_text_delta', id: 'r1', delta: 'hmm' },
      { type: 'reasoning_text_done', id: 'r1', text: 'hmm' },
      { type: 'assistant_text_delta', id: 't1', delta: 'first ' },
      { type: 'assistant_text_delta', id: 't1', delta: 'block' },
      { type: 'assistant_text_done', id: 't1', text: 'first block' },
      { type: 'tool_call_start', callId: 'a', name: 'bash', args: {}, target: 'host' },
      { type: 'tool_call_start', callId: 'b', name: 'read', args: {}, target: 'host' },
      { type: 'tool_call_result', callId: 'b', result: {}, durationMs: 1 },
      { type: 'assistant_text_delta', id: 't2', delta: 'second' },
      { type: 'tool_call_result', callId: 'a', result: {}, durationMs: 1 },
      { type: 'assistant_text_done', id: 't2', text: 'second' },
      { type: 'tool_call_start', callId: 'c', name: 'edit', args: {}, target: 'host' },
      { type: 'tool_call_error', callId: 'c', error: 'boom' },
      { type: 'run_finished', reason: 'stop' },
    ];
    for (const event of events) {
      scrollback.apply(event);
      record();
    }

    for (let i = 1; i < snapshots.length; i++) {
      expectPrefix(snapshots[i - 1]!, snapshots[i]!);
    }
    const { entries, committedCount } = scrollback.splitSnapshot();
    expect(committedCount).toBe(entries.length);
  });
});
