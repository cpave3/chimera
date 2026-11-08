import { describe, expect, it, vi } from 'vitest';
import { PermissionCard } from '../src/cards/permission-card';
import { QuestionCard } from '../src/cards/question-card';
import { type RowContext, renderTranscript } from '../src/ledger/rows';
import type { ScrollbackEntry, SubagentEntry } from '../src/scrollback';
import { stripAnsi } from '../src/terminal/width';
import { BUILTIN_THEMES } from '../src/theme/palette';
import { createStyle } from '../src/theme/style';

const style = createStyle(BUILTIN_THEMES.default, 'ansi16');

// Sets the clipboard, leaves the alternate screen, moves the cursor home, and a C1 CSI.
const HOSTILE = 'before\x1b]52;c;YXR0YWNrZXI=\x07\x1b[?1049l\x1b[H\x9b2J\rafter\x07';

const SGR_SEQUENCE = new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g');
const CONTROL_CHARACTER = new RegExp(String.raw`[\x00-\x08\x0b-\x1f\x7f-\x9f]`);

/** What the styling itself writes: SGR colours and resets only. */
function onlySgr(lines: string[]): void {
  for (const line of lines) {
    const withoutSgr = line.replace(SGR_SEQUENCE, '');
    expect(withoutSgr).not.toMatch(CONTROL_CHARACTER);
  }
}

function render(entries: ScrollbackEntry[], children = new Map<string, SubagentEntry[]>()) {
  const context: RowContext = {
    width: 100,
    style,
    spinner: '⠋',
    sandboxActive: false,
    isExpanded: () => true,
    children,
  };
  return renderTranscript(entries, context).lines;
}

describe('untrusted text reaches the terminal as text', () => {
  it('drops terminal controls from tool output, keeping the text around them', () => {
    const lines = render([
      {
        id: 't1',
        kind: 'tool',
        text: 'bash',
        toolName: 'bash',
        toolTarget: 'host',
        toolArgs: { command: `cat ${HOSTILE}` },
        toolResult: { stdout: HOSTILE, stderr: HOSTILE, exitCode: 0 },
      },
    ]);
    onlySgr(lines);
    expect(lines.map(stripAnsi).join('\n')).toContain('before');
    expect(lines.map(stripAnsi).join('\n')).toContain('after');
  });

  it('drops them from assistant text, your messages, notices and subagent rows', () => {
    const child: SubagentEntry = {
      id: 's1',
      kind: 'subagent',
      text: HOSTILE,
      parentEntryId: 't1',
    } as SubagentEntry;
    const lines = render(
      [
        { id: 'u1', kind: 'user', text: HOSTILE },
        { id: 'a1', kind: 'assistant', text: HOSTILE },
        { id: 'i1', kind: 'info', text: HOSTILE },
        { id: 'r1', kind: 'error', text: HOSTILE },
        {
          id: 't1',
          kind: 'tool',
          text: 'spawn_agent',
          toolName: 'spawn_agent',
          toolTarget: 'host',
          toolArgs: { prompt: HOSTILE },
        },
      ],
      new Map([['t1', [child]]]),
    );
    onlySgr(lines);
  });

  it('drops them from a permission request', () => {
    const card = new PermissionCard(
      { requestId: 'p1', command: `rm ${HOSTILE}`, reason: HOSTILE },
      vi.fn(),
    );
    onlySgr(card.render(100, 30, style));
  });

  it('drops them from a question and its options', () => {
    const card = new QuestionCard(
      {
        requestId: 'q1',
        questions: [{ question: HOSTILE, header: HOSTILE, options: [{ label: HOSTILE }] }],
      },
      vi.fn(),
    );
    onlySgr(card.render(100, 30, style));
  });
});

describe('untrusted text through the mounted TUI', () => {
  it('keeps a hostile bash result from reaching the terminal as controls', async () => {
    const { mount, toolCall } = await import('./harness');
    const mounted = await mount();
    mounted.term.takeOutput();
    await mounted.event(
      ...toolCall('c1', 'bash', { command: 'cat notes.txt' }, 'cat notes.txt', {
        stdout: HOSTILE,
        stderr: '',
        exitCode: 0,
      }),
    );
    await mounted.keys('\x0f');
    const written = mounted.term.takeOutput();
    expect(written).not.toContain('\x1b]52');
    expect(written).not.toContain('\x1b[?1049l');
    expect(mounted.term.alternate).toBe(true);
    expect(mounted.screen()).toContain('beforeafter');
    await mounted.unmount();
    // The transcript printed into the shell's scrollback on exit.
    const exitPrint = mounted.term.takeOutput();
    expect(exitPrint).toContain('beforeafter');
    expect(exitPrint).not.toContain('\x1b]52');
  });

  it('keeps controls out of the pattern a permission request offers to edit', () => {
    const card = new PermissionCard({ requestId: 'p1', command: `rm ${HOSTILE}` }, vi.fn());
    const parserFree = { type: 'key', name: 'g', text: 'g' } as const;
    card.handleKey(parserFree as never);
    onlySgr(card.render(100, 30, style));
  });
});
