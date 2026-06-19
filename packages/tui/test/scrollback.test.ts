import type { Session, ToolCallRecord } from '@chimera/core';
import { describe, expect, it, vi } from 'vitest';
import { Scrollback } from '../src/scrollback';

function rehydrate(messages: unknown[], toolCalls: ToolCallRecord[] = []) {
  const scrollback = new Scrollback();
  scrollback.rehydrateFromSession({
    messages,
    toolCalls,
  } as Pick<Session, 'messages' | 'toolCalls'>);
  return scrollback.all();
}

describe('Scrollback', () => {
  it('accumulates assistant text deltas into a single row', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'assistant_text_delta', delta: 'Hel' });
    scrollback.apply({ type: 'assistant_text_delta', delta: 'lo' });
    const rows = scrollback.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('assistant');
    expect(rows[0]!.text).toBe('Hello');
  });

  it('accumulates reasoning text deltas into a thinking row', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'reasoning_text_delta', delta: 'Hmm' });
    scrollback.apply({ type: 'reasoning_text_delta', delta: '...' });
    const rows = scrollback.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('thinking');
    expect(rows[0]!.text).toBe('Hmm...');
  });

  it('collapses repeated reasoning delta+done cycles for the same id', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'reasoning_text_delta', id: 'r1', delta: 'Think' });
    scrollback.apply({ type: 'reasoning_text_done', id: 'r1', text: 'Think' });
    scrollback.apply({ type: 'reasoning_text_delta', id: 'r1', delta: 'Think' });
    scrollback.apply({ type: 'reasoning_text_done', id: 'r1', text: 'Think' });
    const rows = scrollback.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('thinking');
    expect(rows[0]!.text).toBe('Think');
  });

  it('collapses repeated delta+done cycles for the same text-id into one row', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'Hello' });
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'Hello' });
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'Hello' });
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'Hello' });
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'Hello' });
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'Hello' });
    const rows = scrollback.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('Hello');
  });

  it('keeps distinct text-ids in separate rows', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'first' });
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'first' });
    scrollback.apply({ type: 'assistant_text_delta', id: 't2', delta: 'second' });
    scrollback.apply({ type: 'assistant_text_done', id: 't2', text: 'second' });
    const rows = scrollback.all();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text).toBe('first');
    expect(rows[1]!.text).toBe('second');
  });

  it('treats no-id deltas after a no-id done as a fresh row', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'assistant_text_delta', delta: 'first' });
    scrollback.apply({ type: 'assistant_text_done', text: 'first' });
    scrollback.apply({ type: 'assistant_text_delta', delta: 'second' });
    scrollback.apply({ type: 'assistant_text_done', text: 'second' });
    const rows = scrollback.all();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text).toBe('first');
    expect(rows[1]!.text).toBe('second');
  });

  it('preserves a second assistant turn separated from the first by a tool call', () => {
    // Models often emit a preamble, run tools, then summarize. Both text
    // turns must remain visible — content-dedupe should only collapse
    // back-to-back identical assistant entries, not any pair separated by a
    // tool entry or info message.
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'assistant_text_delta',
      id: 't1',
      delta: "I'll explore the codebase",
    });
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: "I'll explore the codebase" });
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'glob',
      args: { pattern: '**/*.ts' },
      target: 'host',
    });
    scrollback.apply({
      type: 'tool_call_result',
      callId: 'c1',
      result: { files: [] },
      durationMs: 5,
    });
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'Based on my analysis' });
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'Based on my analysis' });
    const rows = scrollback.all();
    const assistantTexts = rows.filter((r) => r.kind === 'assistant').map((r) => r.text);
    expect(assistantTexts).toEqual(["I'll explore the codebase", 'Based on my analysis']);
  });

  it('collapses identical assistant text re-emitted across a tool call when ids match', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'preamble' });
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'preamble' });
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'glob',
      args: { pattern: '**' },
      target: 'host',
    });
    scrollback.apply({
      type: 'tool_call_result',
      callId: 'c1',
      result: [],
      durationMs: 1,
    });
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'preamble' });
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'preamble' });
    const assistantTexts = scrollback
      .all()
      .filter((r) => r.kind === 'assistant')
      .map((r) => r.text);
    expect(assistantTexts).toEqual(['preamble']);
  });

  it('keeps two adjacent assistant entries with matching text but different ids', () => {
    // Distinct logical text parts that happen to share content — must not
    // be silently merged just because their text is identical.
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'Sure.' });
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'Sure.' });
    scrollback.apply({ type: 'assistant_text_delta', id: 't2', delta: 'Sure.' });
    scrollback.apply({ type: 'assistant_text_done', id: 't2', text: 'Sure.' });
    const rows = scrollback.all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.text)).toEqual(['Sure.', 'Sure.']);
  });

  it('records user messages', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'user_message', content: 'hi' });
    expect(scrollback.all()[0]).toMatchObject({ kind: 'user', text: 'hi' });
  });

  it('records tool calls with target badge data', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'bash',
      args: { command: 'echo hi' },
      target: 'host',
    });
    const rows = scrollback.all();
    expect(rows[0]!.kind).toBe('tool');
    expect(rows[0]!.toolTarget).toBe('host');
    expect(rows[0]!.toolName).toBe('bash');
  });

  it('uses display.summary for tool entry text when present', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'edit',
      args: { path: '/work/src/foo.ts', old_string: 'a', new_string: 'b' },
      target: 'sandbox',
      display: { summary: 'src/foo.ts' },
    });
    expect(scrollback.all()[0]!.text).toBe('src/foo.ts');
  });

  it('result-time display overwrites the start-time summary', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'edit',
      args: { path: '/work/src/foo.ts', old_string: 'a', new_string: 'b' },
      target: 'sandbox',
      display: { summary: 'src/foo.ts' },
    });
    scrollback.apply({
      type: 'tool_call_result',
      callId: 'c1',
      result: { replacements: 3 },
      durationMs: 12,
      display: { summary: 'src/foo.ts (3 replacements)' },
    });
    expect(scrollback.all()[0]!.text).toBe('src/foo.ts (3 replacements)');
  });

  it('does not record toolArgs on subagent inner tool entries', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: {
        type: 'tool_call_start',
        callId: 'cc1',
        name: 'bash',
        args: { command: 'ls' },
        target: 'sandbox',
      },
    });
    expect(scrollback.all().some((e) => e.toolArgs !== undefined)).toBe(false);
  });

  it('records the raw tool args on the entry for rich body rendering', () => {
    const scrollback = new Scrollback();
    const args = { path: '/work/a.ts', old_string: 'foo', new_string: 'bar' };
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'edit',
      args,
      target: 'sandbox',
    });
    expect(scrollback.all()[0]!.toolArgs).toEqual(args);
  });

  it('falls back to JSON args when no display is provided', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'bash',
      args: { command: 'echo hi' },
      target: 'host',
    });
    // The renderer prepends the tool name, so `text` carries args only.
    expect(scrollback.all()[0]!.text).toBe('{"command":"echo hi"}');
    expect(scrollback.all()[0]!.toolName).toBe('bash');
  });

  it('persists detail when provided in display', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'spawn_agent',
      args: { prompt: 'go', purpose: 'investigate' },
      target: 'host',
      display: { summary: 'investigate', detail: 'prompt: go' },
    });
    expect(scrollback.all()[0]!.text).toBe('investigate');
    expect(scrollback.all()[0]!.detail).toBe('prompt: go');
  });

  it('clear wipes entries and resets streaming state', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'Hel' });
    scrollback.clear();
    // Streaming state must be wiped so the next delta starts a fresh entry.
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'Hello' });
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'Hello' });
    const rows = scrollback.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('Hello');
  });

  it('clear wipes thinking streaming state', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'reasoning_text_delta', id: 'r1', delta: 'Think' });
    scrollback.clear();
    scrollback.apply({ type: 'reasoning_text_delta', id: 'r1', delta: 'Think' });
    scrollback.apply({ type: 'reasoning_text_done', id: 'r1', text: 'Think' });
    const rows = scrollback.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('thinking');
    expect(rows[0]!.text).toBe('Think');
  });

  it('suppressUserMessageMatching drops a single matching user_message event', () => {
    const scrollback = new Scrollback();
    scrollback.suppressUserMessageMatching('expanded body');
    scrollback.apply({ type: 'user_message', content: 'expanded body' });
    expect(scrollback.all()).toEqual([]);

    // After one consumption, subsequent events render normally.
    scrollback.apply({ type: 'user_message', content: 'next one' });
    expect(scrollback.all()).toHaveLength(1);
    expect(scrollback.all()[0]).toMatchObject({ kind: 'user', text: 'next one' });
  });

  it('attaches skill_activated metadata to the most recent read tool entry', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'read',
      args: { path: '.chimera/skills/pdf/SKILL.md' },
      target: 'host',
    });
    scrollback.apply({ type: 'skill_activated', skillName: 'pdf', source: 'project' });
    const rows = scrollback.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.skillName).toBe('pdf');
    expect(rows[0]!.skillSource).toBe('project');
  });

  it('ignores skill_activated when the most recent tool is not a read', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'bash',
      args: { command: 'echo hi' },
      target: 'host',
    });
    scrollback.apply({ type: 'skill_activated', skillName: 'pdf', source: 'project' });
    expect(scrollback.all()[0]!.skillName).toBeUndefined();
  });

  it('suppressUserMessageMatching on a non-match still renders and clears the flag', () => {
    const scrollback = new Scrollback();
    scrollback.suppressUserMessageMatching('expected');
    scrollback.apply({ type: 'user_message', content: 'something else' });
    // The non-matching content still renders.
    expect(scrollback.all()).toHaveLength(1);
    expect(scrollback.all()[0]!.text).toBe('something else');
    // And the suppression has been cleared, so a later 'expected' renders too.
    scrollback.apply({ type: 'user_message', content: 'expected' });
    expect(scrollback.all()).toHaveLength(2);
  });

  it('renders subagent_spawned with id and purpose', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'subagent_spawned',
      subagentId: 'sub-id-1234',
      parentCallId: 'pc',
      childSessionId: 'child-sess',
      url: 'http://127.0.0.1:8080',
      purpose: 'investigate logs',
    });
    const row = scrollback.all()[0]!;
    expect(row.kind).toBe('subagent');
    expect(row.subagentId).toBe('sub-id-1234');
    expect(row.subagentPurpose).toBe('investigate logs');
    expect(row.subagentStatus).toBe('running');
  });

  it('summarizes subagent_event tool calls and run errors', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: {
        type: 'tool_call_start',
        callId: 'c1',
        name: 'bash',
        args: { command: 'ls' },
        target: 'sandbox',
      },
    });
    scrollback.apply({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: { type: 'run_finished', reason: 'error', error: 'oops' },
    });
    const rows = scrollback.all();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('subagent');
    expect(rows[0]!.text).toContain('bash');
    expect(rows[1]!.text).toContain('oops');
  });

  it('groups subagent rows under the parent spawn_agent tool entry', () => {
    const scrollback = new Scrollback();
    // Parent invokes spawn_agent.
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'pc1',
      name: 'spawn_agent',
      args: { prompt: 'go', purpose: 'investigate' },
      target: 'host',
      display: { summary: 'investigate' },
    });
    // Child spawned: stamps purpose onto the parent, does NOT add a row.
    scrollback.apply({
      type: 'subagent_spawned',
      subagentId: 'sa1',
      parentCallId: 'pc1',
      childSessionId: 'cs',
      url: '',
      purpose: 'investigate',
    });
    // Child runs a tool — appears as a child row with parentEntryId.
    scrollback.apply({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: {
        type: 'tool_call_start',
        callId: 'cc1',
        name: 'read',
        args: { path: '/work/src/x.ts' },
        target: 'sandbox',
        display: { summary: 'src/x.ts' },
      },
    });
    // Result update mutates the same child row.
    scrollback.apply({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: {
        type: 'tool_call_result',
        callId: 'cc1',
        result: { content: '...', total_lines: 87, truncated: false },
        durationMs: 5,
        display: { summary: 'src/x.ts (87 lines)' },
      },
    });
    // Subagent finishes: no separate "finished" row when grouped.
    scrollback.apply({
      type: 'subagent_finished',
      subagentId: 'sa1',
      parentCallId: 'pc1',
      result: 'done',
      reason: 'stop',
    });

    const rows = scrollback.all();
    // Exactly two entries: the parent tool entry + one child read row.
    expect(rows).toHaveLength(2);
    const parent = rows[0]!;
    const child = rows[1]!;
    expect(parent.kind).toBe('tool');
    expect(parent.toolName).toBe('spawn_agent');
    expect(parent.subagentId).toBe('sa1');
    expect(parent.subagentPurpose).toBe('investigate');
    expect(child.kind).toBe('subagent');
    expect(child.parentEntryId).toBe(parent.id);
    expect(child.text).toBe('read: src/x.ts (87 lines)');
  });

  it('routes children of two parallel spawns to their own parents (no cross-talk)', () => {
    const scrollback = new Scrollback();
    // Two spawn_agent tool calls fire in the same assistant message
    // (this is what `/review` does once it's gathered context).
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'pc1',
      name: 'spawn_agent',
      args: { prompt: 'A', purpose: 'consistency review' },
      target: 'host',
      display: { summary: 'consistency review' },
    });
    scrollback.apply({
      type: 'tool_call_start',
      callId: 'pc2',
      name: 'spawn_agent',
      args: { prompt: 'B', purpose: 'tests/docs review' },
      target: 'host',
      display: { summary: 'tests/docs review' },
    });
    // Two subagent_spawned events follow, each pointing to its own parent.
    scrollback.apply({
      type: 'subagent_spawned',
      subagentId: 'saA',
      parentCallId: 'pc1',
      childSessionId: 'csA',
      url: '',
      purpose: 'consistency review',
    });
    scrollback.apply({
      type: 'subagent_spawned',
      subagentId: 'saB',
      parentCallId: 'pc2',
      childSessionId: 'csB',
      url: '',
      purpose: 'tests/docs review',
    });
    // Each subagent emits a distinct child tool call.
    scrollback.apply({
      type: 'subagent_event',
      subagentId: 'saA',
      event: {
        type: 'tool_call_start',
        callId: 'ca1',
        name: 'grep',
        args: { pattern: 'foo' },
        target: 'host',
        display: { summary: 'foo' },
      },
    });
    scrollback.apply({
      type: 'subagent_event',
      subagentId: 'saB',
      event: {
        type: 'tool_call_start',
        callId: 'cb1',
        name: 'bash',
        args: { command: 'npm test' },
        target: 'host',
        display: { summary: 'npm test' },
      },
    });

    const rows = scrollback.all();
    const parents = rows.filter((row) => row.kind === 'tool');
    expect(parents).toHaveLength(2);
    const [parentA, parentB] = parents as [(typeof parents)[number], (typeof parents)[number]];
    expect(parentA.subagentId).toBe('saA');
    expect(parentB.subagentId).toBe('saB');

    const subagentRows = rows.filter((row) => row.kind === 'subagent');
    const childA = subagentRows.find((row) => row.text.includes('grep'));
    const childB = subagentRows.find((row) => row.text.includes('bash'));
    expect(childA).toBeDefined();
    expect(childB).toBeDefined();
    // The grep child must nest under parent A, not B.
    expect((childA as { parentEntryId?: string }).parentEntryId).toBe(parentA.id);
    expect((childB as { parentEntryId?: string }).parentEntryId).toBe(parentB.id);
    // And the parents must keep their own purpose labels.
    expect(parentA.subagentPurpose).toBe('consistency review');
    expect(parentB.subagentPurpose).toBe('tests/docs review');
  });

  it('does not overwrite subagent entries when assistant text deltas arrive interleaved', () => {
    const scrollback = new Scrollback();
    // Start streaming assistant text.
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'Hel' });
    // Interleaved subagent pushes a child tool entry after the assistant row.
    scrollback.apply({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: {
        type: 'tool_call_start',
        callId: 'cc1',
        name: 'bash',
        args: { command: 'ls' },
        target: 'host',
      },
    });
    // Next delta must update the assistant entry, not the subagent entry.
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'lo' });
    const rows = scrollback.all();
    expect(rows).toHaveLength(2);
    const assistantEntry = rows.find((r) => r.kind === 'assistant');
    const subagentEntry = rows.find((r) => r.kind === 'subagent');
    expect(assistantEntry?.text).toBe('Hello');
    expect(subagentEntry?.text).toBe('bash [host]');
    // Finish the assistant turn to ensure cleanup works too.
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'Hello' });
    expect(scrollback.all().find((r) => r.kind === 'assistant')?.text).toBe('Hello');
  });

  it('deduplicates assistant entries across interleaved subagent rows', () => {
    const scrollback = new Scrollback();
    // First assistant turn.
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'preamble' });
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'preamble' });
    // Subagent event lands between turns.
    scrollback.apply({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: {
        type: 'tool_call_start',
        callId: 'cc1',
        name: 'bash',
        args: { command: 'ls' },
        target: 'host',
      },
    });
    // The same text part is re-emitted (SDK can yield the same id again).
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: 'preamble' });
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: 'preamble' });
    // Only one assistant row should survive; the subagent row must remain
    // undisturbed in between.
    const rows = scrollback.all();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.kind === 'assistant')).toHaveLength(1);
    expect(rows.find((r) => r.kind === 'assistant')?.text).toBe('preamble');
    expect(rows.find((r) => r.kind === 'subagent')?.text).toBe('bash [host]');
  });

  it('deduplicates thinking entries across interleaved subagent rows', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'reasoning_text_delta', id: 'r1', delta: 'ponder' });
    scrollback.apply({ type: 'reasoning_text_done', id: 'r1', text: 'ponder' });
    scrollback.apply({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: {
        type: 'tool_call_start',
        callId: 'cc1',
        name: 'bash',
        args: { command: 'ls' },
        target: 'host',
      },
    });
    scrollback.apply({ type: 'reasoning_text_delta', id: 'r1', delta: 'ponder' });
    scrollback.apply({ type: 'reasoning_text_done', id: 'r1', text: 'ponder' });
    const rows = scrollback.all();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.kind === 'thinking')).toHaveLength(1);
    expect(rows.find((r) => r.kind === 'thinking')?.text).toBe('ponder');
    expect(rows.find((r) => r.kind === 'subagent')?.text).toBe('bash [host]');
  });

  it('falls back to a stand-alone row when subagent_spawned has no matching parent', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'subagent_spawned',
      subagentId: 'sa1',
      parentCallId: 'unknown',
      childSessionId: 'cs',
      url: '',
      purpose: 'orphaned',
    });
    expect(scrollback.all()).toHaveLength(1);
    expect(scrollback.all()[0]!.parentEntryId).toBeUndefined();
  });

  it('records subagent_finished with closing summary', () => {
    const scrollback = new Scrollback();
    scrollback.apply({
      type: 'subagent_finished',
      subagentId: 'sa1',
      parentCallId: 'pc',
      result: 'ok',
      reason: 'stop',
    });
    const row = scrollback.all()[0]!;
    expect(row.kind).toBe('subagent');
    expect(row.subagentStatus).toBe('finished');
  });
});

describe('Scrollback.rehydrateFromSession', () => {
  it('renders user + assistant text turns in order', () => {
    const entries = rehydrate([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi back' },
      { role: 'user', content: 'thanks' },
    ]);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.kind).toBe('user');
    expect(entries[0]!.text).toBe('hello');
    expect(entries[1]!.kind).toBe('assistant');
    expect(entries[1]!.text).toBe('hi back');
    expect(entries[2]!.kind).toBe('user');
    expect(entries[2]!.text).toBe('thanks');
  });

  it('skips system messages entirely', () => {
    const entries = rehydrate([
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hi' },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('user');
  });

  it('extracts text parts from array-shaped user content', () => {
    const entries = rehydrate([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first part ' },
          { type: 'text', text: 'second part' },
          { type: 'image', image: 'data:...' },
        ],
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe('first part second part');
  });

  it('counts image parts from array-shaped user content', () => {
    const entries = rehydrate([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', image: '/path/to/img1.png' },
          { type: 'image', image: '/path/to/img2.png' },
        ],
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('user');
    const userEntry = entries[0]! as { imageCount?: number };
    expect(userEntry.imageCount).toBe(2);
  });

  it('addUserMessage accepts an optional imageCount', () => {
    const scrollback = new Scrollback();
    scrollback.addUserMessage('hello', 3);
    const rows = scrollback.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('user');
    const entry = rows[0]! as { imageCount?: number };
    expect(entry.imageCount).toBe(3);
  });

  it('pairs assistant tool-call with subsequent tool-result message', () => {
    const entries = rehydrate([
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'bash',
            input: { command: 'ls -la' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'bash',
            output: {
              type: 'json',
              value: { stdout: 'a\nb\n', stderr: '', exit_code: 0 },
            },
          },
        ],
      },
    ]);
    const toolEntry = entries.find((entry) => entry.kind === 'tool');
    expect(toolEntry).toBeDefined();
    expect(toolEntry!.toolName).toBe('bash');
    expect(toolEntry!.toolResult).toEqual({
      stdout: 'a\nb\n',
      stderr: '',
      exit_code: 0,
    });
  });

  it('unwraps AI-SDK v5 error-text output to toolError', () => {
    const entries = rehydrate([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-err',
            toolName: 'bash',
            input: { command: 'false' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-err',
            toolName: 'bash',
            output: { type: 'error-text', value: 'command failed' },
          },
        ],
      },
    ]);
    const toolEntry = entries.find((entry) => entry.kind === 'tool');
    expect(toolEntry!.toolError).toBe('command failed');
    expect(toolEntry!.toolResult).toBeUndefined();
  });

  it('handles legacy v4 output shape (no discriminator wrapper)', () => {
    const entries = rehydrate([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-legacy',
            toolName: 'read',
            input: { path: '/tmp/x' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-legacy',
            toolName: 'read',
            output: { content: 'file body' },
          },
        ],
      },
    ]);
    const toolEntry = entries.find((entry) => entry.kind === 'tool');
    expect(toolEntry!.toolResult).toEqual({ content: 'file body' });
  });

  it('defaults tool target to host when no matching ToolCallRecord exists', () => {
    const entries = rehydrate([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-noop',
            toolName: 'read',
            input: { path: '/tmp/x' },
          },
        ],
      },
    ]);
    const toolEntry = entries.find((entry) => entry.kind === 'tool');
    expect(toolEntry!.toolTarget).toBe('host');
  });

  it('uses ToolCallRecord.target when name + args match', () => {
    const toolCallRecord: ToolCallRecord = {
      callId: 'agent-side-id',
      name: 'bash',
      args: { command: 'echo hi' },
      target: 'sandbox',
      startedAt: 1,
    };
    const entries = rehydrate(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'sdk-side-id',
              toolName: 'bash',
              input: { command: 'echo hi' },
            },
          ],
        },
      ],
      [toolCallRecord],
    );
    const toolEntry = entries.find((entry) => entry.kind === 'tool');
    expect(toolEntry!.toolTarget).toBe('sandbox');
  });

  it('runs injected formatters during rehydrate so resumed sessions show summaries', () => {
    const scrollback = new Scrollback({
      read: (args, result) => {
        const path = (args as { file_path: string }).file_path;
        const lines = (result as { total_lines?: number } | undefined)?.total_lines;
        return {
          summary: `${path} (${lines ?? '?'} lines)`,
          detail: 'first detail line',
        };
      },
    });
    scrollback.rehydrateFromSession({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'sdk-side-id',
              toolName: 'read',
              input: { file_path: 'package.json' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'sdk-side-id',
              toolName: 'read',
              output: { type: 'json', value: { content: '...', total_lines: 34 } },
            },
          ],
        },
      ],
      toolCalls: [],
    } as Pick<Session, 'messages' | 'toolCalls'>);
    const toolEntry = scrollback.all().find((entry) => entry.kind === 'tool');
    expect(toolEntry).toBeDefined();
    if (toolEntry?.kind !== 'tool') throw new Error('unreachable');
    expect(toolEntry.text).toBe('package.json (34 lines)');
    expect(toolEntry.detail).toBe('first detail line');
  });

  it('falls back to JSON args when no formatter is injected for the tool', () => {
    const entries = rehydrate([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'sdk-side-id',
            toolName: 'read',
            input: { file_path: 'package.json' },
          },
        ],
      },
    ]);
    const toolEntry = entries.find((entry) => entry.kind === 'tool');
    expect(toolEntry).toBeDefined();
    if (toolEntry?.kind !== 'tool') throw new Error('unreachable');
    expect(toolEntry.text).toContain('package.json');
    expect(toolEntry.text).toContain('"file_path"');
  });

  it('catches formatter exceptions and falls back to JSON args', () => {
    const scrollback = new Scrollback({
      read: () => {
        throw new Error('formatter blew up');
      },
    });
    scrollback.rehydrateFromSession({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'sdk-side-id',
              toolName: 'read',
              input: { file_path: 'package.json' },
            },
          ],
        },
      ],
      toolCalls: [],
    } as Pick<Session, 'messages' | 'toolCalls'>);
    const toolEntry = scrollback.all().find((entry) => entry.kind === 'tool');
    expect(toolEntry).toBeDefined();
    if (toolEntry?.kind !== 'tool') throw new Error('unreachable');
    expect(toolEntry.text).toContain('"file_path"');
  });

  it('clears prior entries before rehydrating', () => {
    const scrollback = new Scrollback();
    scrollback.addInfo('this should be wiped');
    scrollback.rehydrateFromSession({
      messages: [{ role: 'user', content: 'fresh' }],
      toolCalls: [],
    } as Pick<Session, 'messages' | 'toolCalls'>);
    expect(scrollback.all()).toHaveLength(1);
    expect(scrollback.all()[0]!.kind).toBe('user');
  });

  it('collapses consecutive mode changes into a single from→to row', () => {
    const scrollback = new Scrollback();
    scrollback.addModeChange('build', 'plan');
    scrollback.addModeChange('plan', 'question');
    scrollback.addModeChange('question', 'build');
    scrollback.addModeChange('build', 'mentor');
    scrollback.addModeChange('mentor', 'build');
    const rows = scrollback.all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('mode_change');
    if (row.kind !== 'mode_change') throw new Error('unreachable');
    expect(row.modeFrom).toBe('build');
    expect(row.modeTo).toBe('build');
    expect(row.text).toBe('Mode change: build → build');
  });

  it('keeps mode changes separate once a non-mode-change entry lands between them', () => {
    const scrollback = new Scrollback();
    scrollback.addModeChange('build', 'plan');
    scrollback.addModeChange('plan', 'question');
    scrollback.addUserMessage('hello');
    scrollback.addModeChange('question', 'build');
    const rows = scrollback.all();
    expect(rows.map((row) => row.kind)).toEqual(['mode_change', 'user', 'mode_change']);
    const first = rows[0]!;
    const second = rows[2]!;
    if (first.kind !== 'mode_change' || second.kind !== 'mode_change') {
      throw new Error('unreachable');
    }
    expect(first.modeFrom).toBe('build');
    expect(first.modeTo).toBe('question');
    expect(second.modeFrom).toBe('question');
    expect(second.modeTo).toBe('build');
  });

  describe('observable store (subscribe / getSnapshot)', () => {
    it('getSnapshot returns the current entries', () => {
      const scrollback = new Scrollback();
      scrollback.addInfo('first');
      expect(scrollback.getSnapshot()).toHaveLength(1);
      expect(scrollback.getSnapshot()[0]!.text).toBe('first');
    });

    it('subscribers are notified after a macrotask batch when entries change', async () => {
      const scrollback = new Scrollback();
      const listener = vi.fn();
      scrollback.subscribe(listener);

      scrollback.addInfo('a');
      // Before macrotask flush: listener should not have been called yet
      expect(listener).not.toHaveBeenCalled();

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('collapses multiple synchronous mutations into a single notification', async () => {
      const scrollback = new Scrollback();
      const listener = vi.fn();
      scrollback.subscribe(listener);

      scrollback.addInfo('a');
      scrollback.addInfo('b');
      scrollback.addInfo('c');

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(scrollback.getSnapshot()).toHaveLength(3);
    });

    it('does not notify after unsubscription', async () => {
      const scrollback = new Scrollback();
      const listener = vi.fn();
      const unsub = scrollback.subscribe(listener);
      unsub();

      scrollback.addInfo('x');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(listener).not.toHaveBeenCalled();
    });

    it('apply() batches all inner event mutations into one notification', async () => {
      const scrollback = new Scrollback();
      const listener = vi.fn();
      scrollback.subscribe(listener);

      scrollback.apply({ type: 'assistant_text_delta', delta: 'Hel' });
      scrollback.apply({ type: 'assistant_text_delta', delta: 'lo' });
      scrollback.apply({
        type: 'tool_call_start',
        callId: 'c1',
        name: 'bash',
        args: {},
        target: 'host',
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(listener).toHaveBeenCalledTimes(1);
      const snapshot = scrollback.getSnapshot();
      expect(snapshot).toHaveLength(2);
    });

    it('apply() on tool_call_result with inner display notifies once', async () => {
      const scrollback = new Scrollback();
      const listener = vi.fn();
      scrollback.subscribe(listener);

      scrollback.apply({
        type: 'tool_call_start',
        callId: 'c1',
        name: 'bash',
        args: { command: 'echo hi' },
        target: 'host',
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      listener.mockClear();

      scrollback.apply({
        type: 'tool_call_result',
        callId: 'c1',
        result: { output: 'hi' },
        durationMs: 5,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
