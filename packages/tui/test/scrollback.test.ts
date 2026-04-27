import type { Session, ToolCallRecord } from '@chimera/core';
import { describe, expect, it } from 'vitest';
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
    scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: "I'll explore the codebase" });
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

  it('clear wipes entries', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'user_message', content: 'hi' });
    scrollback.clear();
    expect(scrollback.all()).toEqual([]);
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
});
