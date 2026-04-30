import { Box } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { ScrollbackEntry } from '../src/scrollback';
import { renderToolBody, TOOL_BODY_LIMITS } from '../src/ToolBody';
import { defaultTheme, plainTheme } from '../src/theme/tokens';

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
    expect(renderToolBody(makeEntry({ toolName: 'mystery' }), ctx)).toEqual([]);
  });

  it('returns nothing when the tool errored (the error is rendered separately)', () => {
    expect(
      renderToolBody(
        makeEntry({
          toolName: 'bash',
          toolError: 'boom',
          toolResult: { stdout: 'x', stderr: '', exit_code: 1, timed_out: false },
        }),
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
      expect(renderToolBody(makeEntry({ toolName: 'edit' }), ctx)).toEqual([]);
    });

    describe('with hunk metadata', () => {
      function hunkEntry(over: {
        old: string;
        new: string;
        startLine: number;
        before?: string[];
        after?: string[];
      }): ScrollbackEntry {
        return makeEntry({
          toolName: 'edit',
          toolArgs: { path: '/x.ts', old_string: over.old, new_string: over.new },
          toolResult: {
            replacements: 1,
            startLine: over.startLine,
            contextBefore: over.before ?? [],
            contextAfter: over.after ?? [],
          },
        });
      }

      it('renders pure insertion with surrounding context as a single hunk', () => {
        const out = frame(
          makeEntry({
            toolName: 'edit',
            toolArgs: {
              path: '/x.ts',
              old_string: 'b\nc',
              new_string: 'b\nNEW\nc',
            },
            toolResult: {
              replacements: 1,
              startLine: 5,
              contextBefore: ['line2', 'line3', 'line4'],
              contextAfter: ['line7', 'line8', 'line9'],
            },
          }),
        );
        // Context rows (above and below) appear with no +/-.
        expect(out).toContain('line4');
        expect(out).toContain('line7');
        // Exactly one + row, zero - rows in the diff body.
        const lines = out.split('\n');
        const plusRows = lines.filter((l) => /\s\+\s/.test(l));
        const minusRows = lines.filter((l) => /\s-\s/.test(l));
        expect(plusRows).toHaveLength(1);
        expect(minusRows).toHaveLength(0);
        expect(plusRows[0]).toContain('NEW');
      });

      it('renders pure deletion as one - row surrounded by context', () => {
        const out = frame(
          hunkEntry({
            old: 'b\nGONE\nc',
            new: 'b\nc',
            startLine: 5,
            before: ['line2', 'line3', 'line4'],
            after: ['line8', 'line9'],
          }),
        );
        const lines = out.split('\n');
        const plusRows = lines.filter((l) => /\s\+\s/.test(l));
        const minusRows = lines.filter((l) => /\s-\s/.test(l));
        expect(minusRows).toHaveLength(1);
        expect(plusRows).toHaveLength(0);
        expect(minusRows[0]).toContain('GONE');
        expect(out).toContain('line4');
        expect(out).toContain('line8');
      });

      it('renders interior unchanged lines as context, not as -/+ pairs', () => {
        const out = frame(
          hunkEntry({
            old: 'shared1\nold-middle\nshared2',
            new: 'shared1\nnew-middle\nshared2',
            startLine: 10,
          }),
        );
        const lines = out.split('\n');
        const plusRows = lines.filter((l) => /\s\+\s/.test(l));
        const minusRows = lines.filter((l) => /\s-\s/.test(l));
        expect(plusRows).toHaveLength(1);
        expect(minusRows).toHaveLength(1);
        expect(minusRows[0]).toContain('old-middle');
        expect(plusRows[0]).toContain('new-middle');
        const shared1Rows = lines.filter((l) => l.includes('shared1'));
        const shared2Rows = lines.filter((l) => l.includes('shared2'));
        expect(shared1Rows).toHaveLength(1);
        expect(shared2Rows).toHaveLength(1);
        expect(/\s[+-]\s/.test(shared1Rows[0]!)).toBe(false);
        expect(/\s[+-]\s/.test(shared2Rows[0]!)).toBe(false);
        // Gutter line numbers: shared1 is line 10, both old-middle and new-middle
        // share line 11 (pre-edit and post-edit respectively), shared2 is line 12.
        expect(shared1Rows[0]).toMatch(/\b10\s+shared1/);
        expect(minusRows[0]).toMatch(/\b11\s+-\s+old-middle/);
        expect(plusRows[0]).toMatch(/\b11\s+\+\s+new-middle/);
        expect(shared2Rows[0]).toMatch(/\b12\s+shared2/);
      });

      it('renders multiple change groups with correct line numbers', () => {
        const out = frame(
          hunkEntry({
            old: 'aaa\nbbb\nccc\nddd\neee',
            new: 'aaa\nBBB\nccc\nDDD\neee',
            startLine: 10,
          }),
        );
        // Expected sequence: 10 same aaa, 11 - bbb, 11 + BBB, 12 same ccc,
        // 13 - ddd, 13 + DDD, 14 same eee.
        expect(out).toMatch(/\b10\s+aaa/);
        expect(out).toMatch(/\b11\s+-\s+bbb/);
        expect(out).toMatch(/\b11\s+\+\s+BBB/);
        expect(out).toMatch(/\b12\s+ccc/);
        expect(out).toMatch(/\b13\s+-\s+ddd/);
        expect(out).toMatch(/\b13\s+\+\s+DDD/);
        expect(out).toMatch(/\b14\s+eee/);
      });

      it('clips hunk rows wider than the available width with an ellipsis', () => {
        const narrowCtx = { width: 30, prefixLen: 2, theme: defaultTheme };
        const longLine = 'x'.repeat(200);
        const els = renderToolBody(
          hunkEntry({ old: longLine, new: 'short', startLine: 1 }),
          narrowCtx,
        );
        const { lastFrame, unmount } = render(<Box flexDirection="column">{els}</Box>);
        const out = lastFrame() ?? '';
        unmount();
        expect(out).toMatch(/x+…/);
        const longest = Math.max(...out.split('\n').map((l) => l.length));
        expect(longest).toBeLessThanOrEqual(narrowCtx.width);
      });

      it('omits leading rows when contextBefore is empty (top-of-file match)', () => {
        const out = frame(
          hunkEntry({
            old: 'first',
            new: 'FIRST',
            startLine: 1,
            before: [],
            after: ['second', 'third'],
          }),
        );
        // Body should start with the diff body (- first / + FIRST), not a context row.
        const lines = out.split('\n').filter((l) => l.trim().length > 0);
        expect(lines[0]).toContain('first');
        expect(/\s-\s/.test(lines[0]!)).toBe(true);
      });

      it('omits trailing rows when contextAfter is empty (end-of-file match)', () => {
        const out = frame(
          hunkEntry({
            old: 'final',
            new: 'FINAL',
            startLine: 99,
            before: ['line96', 'line97', 'line98'],
            after: [],
          }),
        );
        const lines = out.split('\n').filter((l) => l.trim().length > 0);
        expect(lines.at(-1)).toContain('FINAL');
        expect(/\s\+\s/.test(lines.at(-1)!)).toBe(true);
      });

      it('caps total rendered rows at editDiffLines and appends a more-lines row', () => {
        const cap = TOOL_BODY_LIMITS.editDiffLines;
        const oldLines = Array.from({ length: cap + 10 }, (_, i) => `o${i}`);
        const out = frame(
          hunkEntry({
            old: oldLines.join('\n'),
            new: 'replaced',
            startLine: 5,
            before: ['c1', 'c2', 'c3'],
            after: ['c4', 'c5', 'c6'],
          }),
        );
        // Total intended rows = 3 (before) + (cap+10) (del) + 1 (add) + 3 (after) = cap+17.
        // Visible rows = cap content + 1 sep row.
        const overflow = 3 + (cap + 10) + 1 + 3 - cap;
        expect(out).toContain(`${overflow} more lines`);
      });

      it('renders cleanly under plainTheme (NO_COLOR mode) with no bg tokens', () => {
        const els = renderToolBody(
          hunkEntry({
            old: 'a',
            new: 'b',
            startLine: 1,
            after: ['c'],
          }),
          { width: 80, prefixLen: 7, theme: plainTheme },
        );
        const { lastFrame, unmount } = render(<Box flexDirection="column">{els}</Box>);
        const out = lastFrame() ?? '';
        unmount();
        expect(out).toContain('a');
        expect(out).toContain('b');
        expect(out).toContain('c');
      });

      it('falls back to legacy -/+ rendering when toolResult lacks startLine', () => {
        const out = frame(
          makeEntry({
            toolName: 'edit',
            toolArgs: { path: '/x.ts', old_string: 'foo', new_string: 'bar' },
            // No toolResult: legacy fallback.
          }),
        );
        const lines = out.split('\n');
        expect(lines.some((l) => /^\s*- foo\s*$/.test(l))).toBe(true);
        expect(lines.some((l) => /^\s*\+ bar\s*$/.test(l))).toBe(true);
      });
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
      expect(renderToolBody(makeEntry({ toolName: 'write' }), ctx)).toEqual([]);
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
      expect(renderToolBody(makeEntry({ toolName: 'bash' }), ctx)).toEqual([]);
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
