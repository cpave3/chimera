import { Box } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { ScrollbackEntry } from '../src/scrollback';
import { renderToolBody, TOOL_BODY_LIMITS } from '../src/ToolBody';
import { defaultTheme } from '../src/theme/tokens';

const ctx = { width: 80, prefixLen: 7, theme: defaultTheme };

function frame(entry: ScrollbackEntry): string {
  const els = renderToolBody(entry, ctx);
  const { lastFrame, unmount } = render(<Box flexDirection="column">{els}</Box>);
  const out = lastFrame() ?? '';
  unmount();
  return out;
}

function makeEntry(over: Partial<ScrollbackEntry>): ScrollbackEntry {
  return {
    id: 's1',
    kind: 'tool',
    text: '',
    ...over,
  };
}

describe('renderToolBody', () => {
  it('returns nothing for unknown tools', () => {
    expect(
      renderToolBody(makeEntry({ toolName: 'mystery' }), ctx),
    ).toEqual([]);
  });

  it('returns nothing when the tool errored (the error is rendered separately)', () => {
    expect(
      renderToolBody(
        makeEntry({ toolName: 'bash', toolError: 'boom', toolResult: { stdout: 'x', stderr: '', exit_code: 1, timed_out: false } }),
        ctx,
      ),
    ).toEqual([]);
  });

  describe('edit', () => {
    it('renders old_string as - lines and new_string as + lines', () => {
      const out = frame(
        makeEntry({
          toolName: 'edit',
          toolArgs: { path: '/x.ts', old_string: 'foo\nbar', new_string: 'baz' },
        }),
      );
      expect(out).toContain('- foo');
      expect(out).toContain('- bar');
      expect(out).toContain('+ baz');
    });

    it('handles pure insertion (empty old_string)', () => {
      const out = frame(
        makeEntry({
          toolName: 'edit',
          toolArgs: { path: '/x.ts', old_string: '', new_string: 'hello' },
        }),
      );
      expect(out).toContain('+ hello');
      expect(out).not.toContain('- ');
    });

    it('handles pure deletion (empty new_string)', () => {
      const out = frame(
        makeEntry({
          toolName: 'edit',
          toolArgs: { path: '/x.ts', old_string: 'gone', new_string: '' },
        }),
      );
      expect(out).toContain('- gone');
      expect(out).not.toContain('+ ');
    });

    it('truncates large diffs with a more-lines hint', () => {
      const oldCount = 50;
      const newCount = 1;
      const totalLines = oldCount + newCount;
      const big = Array.from({ length: oldCount }, (_, i) => `old${i}`).join('\n');
      const out = frame(
        makeEntry({
          toolName: 'edit',
          toolArgs: { path: '/x.ts', old_string: big, new_string: 'short' },
        }),
      );
      const cap = TOOL_BODY_LIMITS.editDiffLines;
      expect(out).toContain(`${totalLines - cap} more lines`);
    });

    it('strips a single trailing newline so it does not produce a blank diff row', () => {
      const out = frame(
        makeEntry({
          toolName: 'edit',
          toolArgs: { path: '/x.ts', old_string: 'foo\n', new_string: 'bar\n' },
        }),
      );
      const minus = out.split('\n').filter((l) => l.includes('- ')).length;
      const plus = out.split('\n').filter((l) => l.includes('+ ')).length;
      expect(minus).toBe(1);
      expect(plus).toBe(1);
      expect(out).toContain('- foo');
      expect(out).toContain('+ bar');
    });

    it('returns nothing when toolArgs is missing', () => {
      expect(
        renderToolBody(makeEntry({ toolName: 'edit' }), ctx),
      ).toEqual([]);
    });
  });

  describe('write', () => {
    it('renders content with line numbers', () => {
      const out = frame(
        makeEntry({
          toolName: 'write',
          toolArgs: { path: '/x.ts', content: 'alpha\nbeta' },
        }),
      );
      expect(out).toContain('1 alpha');
      expect(out).toContain('2 beta');
    });

    it('truncates long content with a more-lines hint', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `l${i}`);
      const out = frame(
        makeEntry({
          toolName: 'write',
          toolArgs: { path: '/x.ts', content: lines.join('\n') },
        }),
      );
      const cap = TOOL_BODY_LIMITS.writeContentLines;
      expect(out).toContain(`${50 - cap} more lines`);
    });

    it('returns nothing when toolArgs is missing', () => {
      expect(
        renderToolBody(makeEntry({ toolName: 'write' }), ctx),
      ).toEqual([]);
    });

    it('strips a single trailing newline so the last row is not a blank line', () => {
      const out = frame(
        makeEntry({
          toolName: 'write',
          toolArgs: { path: '/x.ts', content: 'alpha\nbeta\n' },
        }),
      );
      expect(out).toContain('1 alpha');
      expect(out).toContain('2 beta');
      expect(out).not.toMatch(/^\s*3\s*$/m);
    });

    it('shows (no output) when content is empty', () => {
      const out = frame(
        makeEntry({
          toolName: 'write',
          toolArgs: { path: '/x.ts', content: '' },
        }),
      );
      expect(out).toContain('(no output)');
    });
  });

  describe('bash', () => {
    it('renders stdout head', () => {
      const out = frame(
        makeEntry({
          toolName: 'bash',
          toolResult: { stdout: 'hello world', stderr: '', exit_code: 0, timed_out: false },
        }),
      );
      expect(out).toContain('hello world');
    });

    it('renders stderr separately', () => {
      const out = frame(
        makeEntry({
          toolName: 'bash',
          toolResult: { stdout: '', stderr: 'kaboom', exit_code: 1, timed_out: false },
        }),
      );
      expect(out).toContain('kaboom');
    });

    it('shows (no output) when both streams are empty', () => {
      const out = frame(
        makeEntry({
          toolName: 'bash',
          toolResult: { stdout: '', stderr: '', exit_code: 0, timed_out: false },
        }),
      );
      expect(out).toContain('(no output)');
    });

    it('returns nothing while result is still pending', () => {
      expect(
        renderToolBody(makeEntry({ toolName: 'bash' }), ctx),
      ).toEqual([]);
    });

    it('truncates long stdout with a more-lines hint', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `out${i}`);
      const out = frame(
        makeEntry({
          toolName: 'bash',
          toolResult: { stdout: lines.join('\n'), stderr: '', exit_code: 0, timed_out: false },
        }),
      );
      const cap = TOOL_BODY_LIMITS.bashStdoutLines;
      expect(out).toContain(`${30 - cap} more lines`);
    });

    it('truncates long stderr with a more-lines hint', () => {
      const total = TOOL_BODY_LIMITS.bashStderrLines + 5;
      const lines = Array.from({ length: total }, (_, i) => `err${i}`);
      const out = frame(
        makeEntry({
          toolName: 'bash',
          toolResult: { stdout: '', stderr: lines.join('\n'), exit_code: 1, timed_out: false },
        }),
      );
      expect(out).toContain('5 more lines');
    });

    it('renders both stdout and stderr when both are present', () => {
      const out = frame(
        makeEntry({
          toolName: 'bash',
          toolResult: { stdout: 'progress', stderr: 'warning: x', exit_code: 0, timed_out: false },
        }),
      );
      expect(out).toContain('progress');
      expect(out).toContain('warning: x');
    });

    it('strips trailing newlines on stdout', () => {
      const out = frame(
        makeEntry({
          toolName: 'bash',
          toolResult: { stdout: 'hello\n\n', stderr: '', exit_code: 0, timed_out: false },
        }),
      );
      expect(out).toContain('hello');
      // Only one rendered line should contain "hello"; no blank trailing rows.
      expect(out.split('\n').filter((l) => l.trim() === '').length).toBeLessThanOrEqual(1);
    });

    it('treats whitespace-only output as no output', () => {
      const out = frame(
        makeEntry({
          toolName: 'bash',
          toolResult: { stdout: '\n\n', stderr: '', exit_code: 0, timed_out: false },
        }),
      );
      expect(out).toContain('(no output)');
    });

    it('uses singular "line" when only one line is truncated', () => {
      const lines = Array.from(
        { length: TOOL_BODY_LIMITS.bashStdoutLines + 1 },
        (_, i) => `out${i}`,
      );
      const out = frame(
        makeEntry({
          toolName: 'bash',
          toolResult: { stdout: lines.join('\n'), stderr: '', exit_code: 0, timed_out: false },
        }),
      );
      expect(out).toContain('1 more line');
      expect(out).not.toContain('1 more lines');
    });

    it('clips lines wider than the available width with an ellipsis', () => {
      const narrowCtx = { width: 24, prefixLen: 2, theme: defaultTheme };
      const longLine = 'x'.repeat(200);
      const els = renderToolBody(
        makeEntry({
          toolName: 'bash',
          toolResult: { stdout: longLine, stderr: '', exit_code: 0, timed_out: false },
        }),
        narrowCtx,
      );
      const { lastFrame, unmount } = render(<Box flexDirection="column">{els}</Box>);
      const out = lastFrame() ?? '';
      unmount();
      expect(out).toMatch(/x+…/);
      // Visible body line (after the prefixLen indent) should respect the width budget.
      const longest = Math.max(...out.split('\n').map((l) => l.length));
      expect(longest).toBeLessThanOrEqual(narrowCtx.width);
    });
  });
});
