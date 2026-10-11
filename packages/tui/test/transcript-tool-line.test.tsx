import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { ScrollbackEntry, ToolEntry } from '../src/scrollback';
import { defaultTheme } from '../src/theme/tokens';
import { renderEntryLines } from '../src/transcript';

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
  it('shows a call in flight with a bullet', () => {
    expect(line(bash({}))).toBe('• bash: pnpm test');
  });

  it('ticks a call that returned', () => {
    expect(line(bash({ text: 'pnpm test (exit 0)', toolResult: { exit_code: 0 } }))).toBe(
      '✓ bash: pnpm test (exit 0)',
    );
  });

  it('crosses a call that failed and a command that exited non-zero', () => {
    expect(line(bash({ toolError: 'spawn ENOENT' }))).toMatch(/^✗ bash: pnpm test/);
    expect(line(bash({ text: 'pnpm test (exit 1)', toolResult: { exit_code: 1 } }))).toBe(
      '✗ bash: pnpm test (exit 1)',
    );
  });

  it('adds the duration of a call that took a second or more', () => {
    expect(line(bash({ toolResult: { exit_code: 0 }, durationMs: 8_240 }))).toBe(
      '✓ bash: pnpm test · 8.2s',
    );
    expect(line(bash({ toolResult: { exit_code: 0 }, durationMs: 95_000 }))).toBe(
      '✓ bash: pnpm test · 1m 35s',
    );
    expect(line(bash({ toolResult: { exit_code: 0 }, durationMs: 420 }))).toBe('✓ bash: pnpm test');
  });

  it('draws the turn summary as a closing rule', () => {
    expect(line({ id: 's1', kind: 'turn', text: '12s · 3 steps · 4 tool calls' })).toBe(
      '─── 12s · 3 steps · 4 tool calls',
    );
  });
});
