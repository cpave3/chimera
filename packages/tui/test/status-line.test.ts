import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { type PromptBoxState, renderPromptBox } from '../src/ledger/prompt-box';
import {
  buildStatusPayload,
  DEFAULT_STATUS_ROWS,
  renderStatusLine,
  type StatusFacts,
} from '../src/ledger/status-line';
import { displayWidth, stripAnsi } from '../src/terminal/width';
import { BUILTIN_THEMES } from '../src/theme/palette';
import { createStyle } from '../src/theme/style';

const style = createStyle(BUILTIN_THEMES.default, 'ansi16');

function facts(overrides: Partial<StatusFacts> = {}): StatusFacts {
  return {
    modelRef: 'anthropic/claude-sonnet',
    visionRouteRef: null,
    usage: {
      usage: {
        inputTokens: 76_000,
        outputTokens: 3_700,
        cachedInputTokens: 50_000,
        totalTokens: 79_700,
        stepCount: 3,
        lastStep: {
          inputTokens: 40_000,
          outputTokens: 1_000,
          cachedInputTokens: 32_000,
          totalTokens: 41_000,
        },
      },
      contextWindow: 200_000,
      usedContextTokens: 76_000,
      unknownWindow: false,
    },
    cwd: `${homedir()}/Projects/yggdrasil`,
    branch: { name: 'yg/json-flag', ahead: 2, behind: 0 },
    sessionId: 'sess_01HX8AWWBRGC',
    sandbox: 'os',
    goal: null,
    update: null,
    ...overrides,
  };
}

const plainRows = (rows: string[]) => rows.map(stripAnsi);

describe('renderStatusLine with the default rows', () => {
  it('shows model and context left, cwd and branch right, then session and sandbox', () => {
    const { border, below } = renderStatusLine(DEFAULT_STATUS_ROWS, facts(), 120, style);
    expect(stripAnsi(border.left)).toBe('anthropic/claude-sonnet · 38%/200k');
    expect(stripAnsi(border.right)).toBe('~/Projects/yggdrasil · yg/json-flag ↑2');
    expect(plainRows(below)).toEqual(['sess_01HX8AWWBRGC'.slice(-8) + ' · os sandbox']);
  });

  it('drops items from the end of each list, the right list first, until a row fits', () => {
    const at80 = renderStatusLine(DEFAULT_STATUS_ROWS, facts(), 80, style).border;
    expect(stripAnsi(at80.left)).toBe('anthropic/claude-sonnet · 38%/200k');
    expect(stripAnsi(at80.right)).toBe('~/Projects/yggdrasil');
    const at50 = renderStatusLine(DEFAULT_STATUS_ROWS, facts(), 50, style).border;
    expect(stripAnsi(at50.left)).toBe('anthropic/claude-sonnet');
    expect(stripAnsi(at50.right)).toBe('');
  });

  it('colours the context figure by how full the window is', () => {
    const at = (percent: number) =>
      renderStatusLine(
        [{ left: ['context'] }],
        facts({ usage: { ...facts().usage!, usedContextTokens: percent * 2_000 } }),
        120,
        style,
      ).border.left;
    expect(at(69)).toContain('\x1b[2;90m69%/200k');
    expect(at(71)).toContain('\x1b[33m71%/200k');
    expect(at(91)).toContain('\x1b[31m91%/200k');
  });
});

describe('renderStatusLine with custom rows', () => {
  it('draws the items asked for, and leaves out the ones without a value', () => {
    const { border, below } = renderStatusLine(
      [{ left: ['tokens', 'cache', 'cost'] }, { left: ['goal'], right: ['model'] }],
      facts({ goal: 'all tests pass' }),
      100,
      style,
    );
    expect(stripAnsi(border.left)).toBe('↑76k ↓3.7k · cache 80%');
    expect(stripAnsi(below[0]!)).toMatch(/^goal: all tests pass +anthropic\/claude-sonnet$/);
    expect(displayWidth(below[0]!)).toBeLessThanOrEqual(100);
  });

  it('shows the vision route with the model', () => {
    const { border } = renderStatusLine(
      [{ left: ['model'] }],
      facts({ visionRouteRef: 'openai/gpt-4o' }),
      100,
      style,
    );
    expect(stripAnsi(border.left)).toBe('anthropic/claude-sonnet → openai/gpt-4o (vision)');
  });
});

describe('buildStatusPayload', () => {
  it('follows the Claude Code statusLine shape, with Chimera facts under chimera', () => {
    const payload = buildStatusPayload(facts(), { version: 'dev', mode: 'build' });
    expect(payload).toMatchObject({
      hook_event_name: 'Status',
      session_id: 'sess_01HX8AWWBRGC',
      cwd: `${homedir()}/Projects/yggdrasil`,
      model: { id: 'anthropic/claude-sonnet', display_name: 'claude-sonnet' },
      workspace: { current_dir: `${homedir()}/Projects/yggdrasil` },
      version: 'dev',
      output_style: { name: 'build' },
      context_window: {
        context_window_size: 200_000,
        total_input_tokens: 76_000,
        total_output_tokens: 3_700,
      },
      chimera: { mode: 'build', sandbox: 'os', branch: 'yg/json-flag', context_percent: 38 },
    });
  });
});

describe('renderPromptBox', () => {
  const statusLine = renderStatusLine(DEFAULT_STATUS_ROWS, facts(), 80, style);
  const state = (overrides: Partial<PromptBoxState> = {}): PromptBoxState => ({
    mode: { name: 'build' },
    activity: null,
    buffer: { text: '', cursor: 0 },
    waiting: false,
    statusLine,
    ...overrides,
  });

  it('draws a rounded box with the mode on top, `? help` when idle, and the status line below', () => {
    const lines = renderPromptBox(state(), 80, style);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(80);
    expect(plainRows(lines)).toEqual([
      `╭─ build ${'─'.repeat(61)} ? help ─╮`,
      `│ › ${' '.repeat(74)} │`,
      `╰─ anthropic/claude-sonnet · 38%/200k ${'─'.repeat(18)} ~/Projects/yggdrasil ─╯`,
      '   ' + 'sess_01HX8AWWBRGC'.slice(-8) + ' · os sandbox',
    ]);
    expect(lines[0]!.length).toBeGreaterThan(stripAnsi(lines[0]!).length);
  });

  it('shows the spinner, elapsed time and run keys on top while running', () => {
    const [top] = plainRows(
      renderPromptBox(state({ activity: { spinner: '⠋', elapsedMs: 12_000 } }), 80, style),
    );
    expect(top!.endsWith('─ ⠋ 12s · esc interrupt · tab queue ─╮')).toBe(true);
  });

  it('wraps a multi-line message and marks the cursor', () => {
    const lines = renderPromptBox(
      state({ buffer: { text: 'first line\nsecond', cursor: 3 } }),
      40,
      style,
    );
    expect(plainRows(lines).slice(1, 3)).toEqual([
      `│ › first line${' '.repeat(24)} │`,
      `│   second${' '.repeat(28)} │`,
    ]);
    expect(lines[1]).toContain('\x1b[7ms\x1b[27m');
  });

  it('says where input goes while a card waits for an answer', () => {
    const [, body] = plainRows(renderPromptBox(state({ waiting: true }), 60, style));
    expect(body).toContain('waiting for your answer above');
  });

  it('styles a shell command, attachments and paste markers', () => {
    const bang = renderPromptBox(state({ buffer: { text: '!ls', cursor: 3 } }), 60, style)[1]!;
    expect(stripAnsi(bang).startsWith('│ $ !ls')).toBe(true);
    const attach = renderPromptBox(
      state({ buffer: { text: 'see @src/a.ts and [Pasted text #1, 9 lines]', cursor: 0 } }),
      80,
      style,
    )[1]!;
    expect(attach).toContain('\x1b[34m@src/a.ts\x1b[39m');
    expect(attach).toContain('\x1b[90m[Pasted text #1, 9 lines]\x1b[39m');
  });

  it('puts the extra lines of a status line command under the box', () => {
    const lines = plainRows(
      renderPromptBox(
        state({
          statusLine: { border: { left: 'from script', right: '' }, below: ['second row'] },
        }),
        40,
        style,
      ),
    );
    expect(lines.at(-2)).toBe(`╰─ from script ${'─'.repeat(24)}╯`);
    expect(lines.at(-1)).toBe('   second row');
  });
});
