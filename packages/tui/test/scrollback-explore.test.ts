import type { AgentEvent } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { Scrollback, type ScrollbackEntry } from '../src/scrollback';

let nextCall = 0;

function toolCall(name: string, summary: string, result: unknown = { ok: true }): AgentEvent[] {
  const callId = `call-${nextCall++}` as never;
  return [
    { type: 'tool_call_start', callId, name, args: {}, target: 'host', display: { summary } },
    { type: 'tool_call_result', callId, result, durationMs: 1, display: { summary } },
  ];
}

function feed(scrollback: Scrollback, events: AgentEvent[]): void {
  for (const event of events) scrollback.apply(event);
}

const kinds = (entries: ScrollbackEntry[]) => entries.map((entry) => entry.kind);

describe('grouped exploration calls', () => {
  it('collapses consecutive reads and searches into one entry', () => {
    const scrollback = new Scrollback();
    feed(scrollback, [
      ...toolCall('read', 'src/a.ts'),
      ...toolCall('read', 'src/b.ts'),
      ...toolCall('grep', 'TODO'),
      ...toolCall('glob', '**/*.md'),
      ...toolCall('read', 'src/c.ts'),
    ]);

    const entries = scrollback.all();
    expect(kinds(entries)).toEqual(['explore']);
    expect(entries[0]!.text).toBe('read 3 files · 1 search · 1 listing');
    const group = entries[0] as Extract<ScrollbackEntry, { kind: 'explore' }>;
    expect(group.members.map((member) => member.text)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'TODO',
      '**/*.md',
      'src/c.ts',
    ]);
  });

  it('closes a group once something else follows it', () => {
    const scrollback = new Scrollback();
    feed(scrollback, [...toolCall('read', 'src/a.ts'), ...toolCall('read', 'src/b.ts')]);
    feed(scrollback, toolCall('edit', 'src/a.ts (1 replacement)'));
    feed(scrollback, toolCall('read', 'src/c.ts'));

    expect(kinds(scrollback.all())).toEqual(['explore', 'tool', 'explore']);
  });

  it('starts a new group after any other entry', () => {
    const scrollback = new Scrollback();
    feed(scrollback, [
      ...toolCall('read', 'src/a.ts'),
      { type: 'assistant_text_done', id: 't1', text: 'I will look at b next.' },
      ...toolCall('read', 'src/b.ts'),
    ]);

    expect(kinds(scrollback.all())).toEqual(['explore', 'assistant', 'explore']);
  });

  it('leaves a failed call and an image read on their own lines', () => {
    const scrollback = new Scrollback();
    const failed = `call-${nextCall++}` as never;
    feed(scrollback, [
      ...toolCall('read', 'src/a.ts'),
      { type: 'tool_call_start', callId: failed, name: 'read', args: {}, target: 'host' },
      { type: 'tool_call_error', callId: failed, error: 'ENOENT' },
      ...toolCall('read', 'shot.png', { kind: 'image', data: 'data:image/png;base64,AAAA' }),
      ...toolCall('read', 'src/b.ts'),
    ]);

    expect(kinds(scrollback.all())).toEqual(['explore', 'tool', 'tool', 'explore']);
  });

  it('collects parallel calls that finish out of order', () => {
    const scrollback = new Scrollback();
    const first = toolCall('read', 'src/a.ts');
    const second = toolCall('read', 'src/b.ts');
    feed(scrollback, [first[0]!, second[0]!, second[1]!, first[1]!]);

    const entries = scrollback.all();
    expect(kinds(entries)).toEqual(['explore']);
    expect(entries[0]!.text).toBe('read 2 files');
  });

  it('closes the open group when the run ends', () => {
    const scrollback = new Scrollback();
    feed(scrollback, [
      ...toolCall('read', 'src/a.ts'),
      ...toolCall('read', 'src/b.ts'),
      { type: 'run_finished', reason: 'stop' },
    ]);

    const entries = scrollback.all();
    expect(kinds(entries)).toEqual(['explore', 'turn']);
    expect(entries[0]).toMatchObject({ kind: 'explore', closed: true });
  });

  it('keeps a skill read visible as its own line', () => {
    const scrollback = new Scrollback();
    feed(scrollback, [
      ...toolCall('read', 'src/a.ts'),
      ...toolCall('read', '/skills/tdd/SKILL.md'),
      { type: 'skill_activated', skillName: 'tdd', source: 'user' },
    ]);

    const entries = scrollback.all();
    expect(kinds(entries)).toEqual(['explore', 'tool']);
    expect(entries[1]).toMatchObject({ toolName: 'read', skillName: 'tdd' });
  });
});
