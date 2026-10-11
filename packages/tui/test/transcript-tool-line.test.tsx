import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { ScrollbackEntry, ToolEntry } from '../src/scrollback';
import { defaultTheme } from '../src/theme/tokens';
import { entryGap, renderEntryLines, wrapWords } from '../src/transcript';

function line(entry: ScrollbackEntry): string {
  const { lastFrame, unmount } = render(
    <Box flexDirection="column">{renderEntryLines(entry, 100, defaultTheme)}</Box>,
  );
  const out = lastFrame() ?? '';
  unmount();
  return out.split('\n')[0] ?? '';
}

function bash(extra: Partial<ToolEntry>): ToolEntry {
  return {
    id: 't1',
    kind: 'tool',
    toolName: 'bash',
    toolTarget: 'host',
    text: 'pnpm test',
    ...extra,
  };
}

describe('tool line state', () => {
  it('shows a call in flight with a hollow dot', () => {
    expect(line(bash({}))).toBe('○ bash pnpm test');
  });

  it('fills the dot of a call that returned', () => {
    expect(line(bash({ text: 'pnpm test (exit 0)', toolResult: { exit_code: 0 } }))).toBe(
      '● bash pnpm test (exit 0)',
    );
  });

  it('crosses a call that failed and a command that exited non-zero', () => {
    expect(line(bash({ toolError: 'spawn ENOENT' }))).toMatch(/^✗ bash pnpm test/);
    expect(line(bash({ text: 'pnpm test (exit 1)', toolResult: { exit_code: 1 } }))).toBe(
      '✗ bash pnpm test (exit 1)',
    );
  });

  it('adds the duration of a call that took a second or more', () => {
    expect(line(bash({ toolResult: { exit_code: 0 }, durationMs: 8_240 }))).toBe(
      '● bash pnpm test · 8.2s',
    );
    expect(line(bash({ toolResult: { exit_code: 0 }, durationMs: 95_000 }))).toBe(
      '● bash pnpm test · 1m 35s',
    );
    expect(line(bash({ toolResult: { exit_code: 0 }, durationMs: 420 }))).toBe('● bash pnpm test');
  });

  it('marks assistant text with a diamond', () => {
    expect(line({ id: 'a1', kind: 'assistant', text: 'Added the flag.' })).toBe(
      '◆ Added the flag.',
    );
  });

  it('draws the body of an edit inside a border', () => {
    const edit: ToolEntry = {
      id: 'e1',
      kind: 'tool',
      toolName: 'edit',
      toolTarget: 'host',
      text: 'src/list.ts (1 replacement)',
      toolArgs: { old_string: 'const rows = 1;', new_string: 'const rows = 2;' },
      toolResult: { startLine: 44, contextBefore: [], contextAfter: [] },
    };
    const { lastFrame, unmount } = render(
      <Box flexDirection="column">{renderEntryLines(edit, 60, defaultTheme)}</Box>,
    );
    const rows = (lastFrame() ?? '').split('\n');
    unmount();
    expect(rows[0]).toBe('● edit src/list.ts (1 replacement)');
    expect(rows[1]).toMatch(/^ {2}╭─+╮$/);
    expect(rows[2]).toMatch(/^ {2}│ 44 - const rows = 1; +│$/);
    expect(rows[3]).toMatch(/^ {2}│ 44 \+ const rows = 2; +│$/);
    expect(rows[4]).toMatch(/^ {2}╰─+╯$/);
  });

  it('draws the turn summary as a closing rule', () => {
    expect(line({ id: 's1', kind: 'turn', text: '12s · 3 steps · 4 tool calls' })).toBe(
      '─── 12s · 3 steps · 4 tool calls',
    );
  });
});

describe('entryGap', () => {
  const tool = bash({ toolResult: { exit_code: 0 } });
  const user: ScrollbackEntry = { id: 'u1', kind: 'user', text: 'go' };
  const assistant: ScrollbackEntry = { id: 'a1', kind: 'assistant', text: 'done' };

  it('keeps tool lines that follow each other together', () => {
    expect(entryGap(tool, { ...tool, id: 't2' })).toBe(0);
  });

  it('puts a blank line between a message and a tool line', () => {
    expect(entryGap(user, tool)).toBe(1);
    expect(entryGap(tool, assistant)).toBe(1);
    expect(entryGap(undefined, user)).toBe(1);
  });
});

describe('wrapWords', () => {
  it('breaks a long line between words', () => {
    expect(wrapWords('add a flag to the list command', 16, 2)).toEqual([
      'add a flag to',
      'the list command',
    ]);
  });

  it('breaks a word that is longer than a line', () => {
    expect(wrapWords('see packages/tui/src/transcript.tsx now', 12, 0)).toEqual([
      'see',
      'packages/tui',
      '/src/transcr',
      'ipt.tsx now',
    ]);
  });

  it('keeps the line breaks and the indentation the user typed', () => {
    expect(wrapWords('one\n\n  two three', 20, 2)).toEqual(['one', '', '  two three']);
  });
});

describe('a user message', () => {
  it('wraps between words, under its marker', () => {
    const { lastFrame, unmount } = render(
      <Box flexDirection="column">
        {renderEntryLines(
          { id: 'u1', kind: 'user', text: 'add a flag to the list command' },
          18,
          defaultTheme,
        )}
      </Box>,
    );
    const rows = (lastFrame() ?? '').split('\n');
    unmount();

    expect(rows).toEqual(['› add a flag to', '  the list command']);
  });
});
