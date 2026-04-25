import { describe, expect, it } from 'vitest';
import { Scrollback } from '../src/scrollback';

describe('Scrollback', () => {
  it('accumulates assistant text deltas into a single row', () => {
    const sb = new Scrollback();
    sb.apply({ type: 'assistant_text_delta', delta: 'Hel' });
    sb.apply({ type: 'assistant_text_delta', delta: 'lo' });
    const rows = sb.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('assistant');
    expect(rows[0]!.text).toBe('Hello');
  });

  it('records user messages', () => {
    const sb = new Scrollback();
    sb.apply({ type: 'user_message', content: 'hi' });
    expect(sb.all()[0]).toMatchObject({ kind: 'user', text: 'hi' });
  });

  it('records tool calls with target badge data', () => {
    const sb = new Scrollback();
    sb.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'bash',
      args: { command: 'echo hi' },
      target: 'host',
    });
    const rows = sb.all();
    expect(rows[0]!.kind).toBe('tool');
    expect(rows[0]!.toolTarget).toBe('host');
    expect(rows[0]!.toolName).toBe('bash');
  });

  it('uses display.summary for tool entry text when present', () => {
    const sb = new Scrollback();
    sb.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'edit',
      args: { path: '/work/src/foo.ts', old_string: 'a', new_string: 'b' },
      target: 'sandbox',
      display: { summary: 'src/foo.ts' },
    });
    expect(sb.all()[0]!.text).toBe('src/foo.ts');
  });

  it('result-time display overwrites the start-time summary', () => {
    const sb = new Scrollback();
    sb.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'edit',
      args: { path: '/work/src/foo.ts', old_string: 'a', new_string: 'b' },
      target: 'sandbox',
      display: { summary: 'src/foo.ts' },
    });
    sb.apply({
      type: 'tool_call_result',
      callId: 'c1',
      result: { replacements: 3 },
      durationMs: 12,
      display: { summary: 'src/foo.ts (3 replacements)' },
    });
    expect(sb.all()[0]!.text).toBe('src/foo.ts (3 replacements)');
  });

  it('does not record toolArgs on subagent inner tool entries', () => {
    const sb = new Scrollback();
    sb.apply({
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
    expect(sb.all().some((e) => e.toolArgs !== undefined)).toBe(false);
  });

  it('records the raw tool args on the entry for rich body rendering', () => {
    const sb = new Scrollback();
    const args = { path: '/work/a.ts', old_string: 'foo', new_string: 'bar' };
    sb.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'edit',
      args,
      target: 'sandbox',
    });
    expect(sb.all()[0]!.toolArgs).toEqual(args);
  });

  it('falls back to JSON args when no display is provided', () => {
    const sb = new Scrollback();
    sb.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'bash',
      args: { command: 'echo hi' },
      target: 'host',
    });
    // The renderer prepends the tool name, so `text` carries args only.
    expect(sb.all()[0]!.text).toBe('{"command":"echo hi"}');
    expect(sb.all()[0]!.toolName).toBe('bash');
  });

  it('persists detail when provided in display', () => {
    const sb = new Scrollback();
    sb.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'spawn_agent',
      args: { prompt: 'go', purpose: 'investigate' },
      target: 'host',
      display: { summary: 'investigate', detail: 'prompt: go' },
    });
    expect(sb.all()[0]!.text).toBe('investigate');
    expect(sb.all()[0]!.detail).toBe('prompt: go');
  });

  it('clear wipes entries', () => {
    const sb = new Scrollback();
    sb.apply({ type: 'user_message', content: 'hi' });
    sb.clear();
    expect(sb.all()).toEqual([]);
  });

  it('suppressUserMessageMatching drops a single matching user_message event', () => {
    const sb = new Scrollback();
    sb.suppressUserMessageMatching('expanded body');
    sb.apply({ type: 'user_message', content: 'expanded body' });
    expect(sb.all()).toEqual([]);

    // After one consumption, subsequent events render normally.
    sb.apply({ type: 'user_message', content: 'next one' });
    expect(sb.all()).toHaveLength(1);
    expect(sb.all()[0]).toMatchObject({ kind: 'user', text: 'next one' });
  });

  it('attaches skill_activated metadata to the most recent read tool entry', () => {
    const sb = new Scrollback();
    sb.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'read',
      args: { path: '.chimera/skills/pdf/SKILL.md' },
      target: 'host',
    });
    sb.apply({ type: 'skill_activated', skillName: 'pdf', source: 'project' });
    const rows = sb.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.skillName).toBe('pdf');
    expect(rows[0]!.skillSource).toBe('project');
  });

  it('ignores skill_activated when the most recent tool is not a read', () => {
    const sb = new Scrollback();
    sb.apply({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'bash',
      args: { command: 'echo hi' },
      target: 'host',
    });
    sb.apply({ type: 'skill_activated', skillName: 'pdf', source: 'project' });
    expect(sb.all()[0]!.skillName).toBeUndefined();
  });

  it('suppressUserMessageMatching on a non-match still renders and clears the flag', () => {
    const sb = new Scrollback();
    sb.suppressUserMessageMatching('expected');
    sb.apply({ type: 'user_message', content: 'something else' });
    // The non-matching content still renders.
    expect(sb.all()).toHaveLength(1);
    expect(sb.all()[0]!.text).toBe('something else');
    // And the suppression has been cleared, so a later 'expected' renders too.
    sb.apply({ type: 'user_message', content: 'expected' });
    expect(sb.all()).toHaveLength(2);
  });

  it('renders subagent_spawned with id and purpose', () => {
    const sb = new Scrollback();
    sb.apply({
      type: 'subagent_spawned',
      subagentId: 'sub-id-1234',
      parentCallId: 'pc',
      childSessionId: 'child-sess',
      url: 'http://127.0.0.1:8080',
      purpose: 'investigate logs',
    });
    const row = sb.all()[0]!;
    expect(row.kind).toBe('subagent');
    expect(row.subagentId).toBe('sub-id-1234');
    expect(row.subagentPurpose).toBe('investigate logs');
    expect(row.subagentStatus).toBe('running');
  });

  it('summarizes subagent_event tool calls and run errors', () => {
    const sb = new Scrollback();
    sb.apply({
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
    sb.apply({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: { type: 'run_finished', reason: 'error', error: 'oops' },
    });
    const rows = sb.all();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('subagent');
    expect(rows[0]!.text).toContain('bash');
    expect(rows[1]!.text).toContain('oops');
  });

  it('groups subagent rows under the parent spawn_agent tool entry', () => {
    const sb = new Scrollback();
    // Parent invokes spawn_agent.
    sb.apply({
      type: 'tool_call_start',
      callId: 'pc1',
      name: 'spawn_agent',
      args: { prompt: 'go', purpose: 'investigate' },
      target: 'host',
      display: { summary: 'investigate' },
    });
    // Child spawned: stamps purpose onto the parent, does NOT add a row.
    sb.apply({
      type: 'subagent_spawned',
      subagentId: 'sa1',
      parentCallId: 'pc1',
      childSessionId: 'cs',
      url: '',
      purpose: 'investigate',
    });
    // Child runs a tool — appears as a child row with parentEntryId.
    sb.apply({
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
    sb.apply({
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
    sb.apply({
      type: 'subagent_finished',
      subagentId: 'sa1',
      parentCallId: 'pc1',
      result: 'done',
      reason: 'stop',
    });

    const rows = sb.all();
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
    const sb = new Scrollback();
    sb.apply({
      type: 'subagent_spawned',
      subagentId: 'sa1',
      parentCallId: 'unknown',
      childSessionId: 'cs',
      url: '',
      purpose: 'orphaned',
    });
    expect(sb.all()).toHaveLength(1);
    expect(sb.all()[0]!.parentEntryId).toBeUndefined();
  });

  it('records subagent_finished with closing summary', () => {
    const sb = new Scrollback();
    sb.apply({
      type: 'subagent_finished',
      subagentId: 'sa1',
      parentCallId: 'pc',
      result: 'ok',
      reason: 'stop',
    });
    const row = sb.all()[0]!;
    expect(row.kind).toBe('subagent');
    expect(row.subagentStatus).toBe('finished');
  });
});
