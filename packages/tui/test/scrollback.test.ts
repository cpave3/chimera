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
});
