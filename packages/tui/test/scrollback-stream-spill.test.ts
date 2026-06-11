import { describe, expect, it } from 'vitest';
import { Scrollback } from '../src/scrollback';

describe('Scrollback streaming paragraph spill', () => {
  it('spills completed paragraphs into committed entries while the tail keeps streaming', () => {
    const scrollback = new Scrollback({}, { streamSpillLines: 3 });

    scrollback.apply({
      type: 'assistant_text_delta',
      id: 't1',
      delta: 'first paragraph\n\nsecond ',
    });
    // 3 lines — at the threshold, not over it: stays monolithic and uncommitted.
    let split = scrollback.splitSnapshot();
    expect(split.entries).toHaveLength(1);
    expect(split.committedCount).toBe(0);

    scrollback.apply({
      type: 'assistant_text_delta',
      id: 't1',
      delta: 'paragraph still going\nmore lines\nand more\n',
    });
    split = scrollback.splitSnapshot();
    expect(split.entries).toHaveLength(2);
    expect(split.entries[0]!.text).toBe('first paragraph');
    expect(split.entries[1]!.text).toBe('second paragraph still going\nmore lines\nand more\n');
    // The completed paragraph is committed; the tail is still in flight.
    expect(split.committedCount).toBe(1);
  });

  it('finalizes only the tail on text_done, without repeating spilled paragraphs', () => {
    const scrollback = new Scrollback({}, { streamSpillLines: 3 });
    const fullText = 'alpha one\nalpha two\n\nbeta one\nbeta two\n\ngamma';

    for (const ch of fullText) {
      scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: ch });
    }
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: fullText });

    const { entries, committedCount } = scrollback.splitSnapshot();
    expect(committedCount).toBe(entries.length);
    // Joining the chunk entries with paragraph breaks reproduces the message.
    expect(entries.map((entry) => entry.text).join('\n\n')).toBe(fullText);
    expect(entries.every((entry) => entry.kind === 'assistant')).toBe(true);
  });

  it('never splits inside an open code fence', () => {
    const scrollback = new Scrollback({}, { streamSpillLines: 3 });
    const fullText = 'intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n\nconst c = 3;\n```\n\nafter';

    for (const ch of fullText) {
      scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: ch });
    }
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: fullText });

    const { entries } = scrollback.splitSnapshot();
    expect(entries.map((entry) => entry.text)).toEqual([
      'intro',
      '```ts\nconst a = 1;\n\nconst b = 2;\n\nconst c = 3;\n```',
      'after',
    ]);
  });

  it('re-emitted text cycles (same textId) do not spill and dedupe away at done', () => {
    const scrollback = new Scrollback({}, { streamSpillLines: 3 });
    const fullText = 'alpha one\nalpha two\n\nbeta one\nbeta two\n\ngamma';

    for (const ch of fullText) {
      scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: ch });
    }
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: fullText });
    const settled = scrollback.splitSnapshot().entries.length;

    // The SDK re-emits the same text part across a step boundary.
    for (const ch of fullText) {
      scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta: ch });
    }
    // The duplicate must stream as a single uncommitted entry — spilling
    // would commit chunks of it that can never be deduped.
    let split = scrollback.splitSnapshot();
    expect(split.entries).toHaveLength(settled + 1);
    expect(split.committedCount).toBe(settled);

    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: fullText });
    split = scrollback.splitSnapshot();
    expect(split.entries).toHaveLength(settled);
    expect(split.committedCount).toBe(settled);
  });

  it('spills streaming thinking text the same way', () => {
    const scrollback = new Scrollback({}, { streamSpillLines: 3 });
    const fullText = 'pondering one\npondering two\n\nstill pondering\nmore\nlines here';

    for (const ch of fullText) {
      scrollback.apply({ type: 'reasoning_text_delta', id: 'r1', delta: ch });
    }
    let split = scrollback.splitSnapshot();
    expect(split.entries.length).toBeGreaterThan(1);
    expect(split.committedCount).toBe(split.entries.length - 1);

    scrollback.apply({ type: 'reasoning_text_done', id: 'r1', text: fullText });
    split = scrollback.splitSnapshot();
    expect(split.committedCount).toBe(split.entries.length);
    expect(split.entries.map((entry) => entry.text).join('\n\n')).toBe(fullText);
    expect(split.entries.every((entry) => entry.kind === 'thinking')).toBe(true);
  });
});
