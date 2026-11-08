import { describe, expect, it } from 'vitest';
import { type RowContext, renderBanner, renderTaskRow, renderTranscript } from '../src/ledger/rows';
import type { ScrollbackEntry, ToolEntry } from '../src/scrollback';
import { displayWidth, stripAnsi } from '../src/terminal/width';
import { BUILTIN_THEMES } from '../src/theme/palette';
import { createStyle } from '../src/theme/style';

const plainStyle = createStyle(BUILTIN_THEMES.default, 'none');

function context(width: number, overrides: Partial<RowContext> = {}): RowContext {
  return {
    width,
    style: createStyle(BUILTIN_THEMES.default, 'ansi16'),
    spinner: '⠋',
    sandboxActive: false,
    isExpanded: () => false,
    children: new Map(),
    ...overrides,
  };
}

function plain(entries: ScrollbackEntry[], width: number, overrides: Partial<RowContext> = {}) {
  const lines = renderTranscript(entries, context(width, overrides)).lines;
  for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width);
  return lines.map((line) => stripAnsi(line).trimEnd());
}

let nextId = 0;
function id(): string {
  nextId += 1;
  return `e${nextId}`;
}

function tool(fields: Partial<ToolEntry> & { toolName: string; text: string }): ToolEntry {
  return { id: id(), kind: 'tool', toolTarget: 'host', ...fields };
}

describe('label column', () => {
  it('right-aligns labels in seven cells plus two spaces, with assistant text unlabelled', () => {
    const lines = plain(
      [
        { id: id(), kind: 'user', text: 'add a --json flag' },
        tool({ toolName: 'read', text: 'src/list.ts (120 lines)', toolResult: {} }),
        tool({ toolName: 'grep', text: '"json" in src (4 matches)', toolResult: {} }),
        { id: id(), kind: 'assistant', text: 'Reusing `printJson`.' },
      ],
      100,
    );
    expect(lines).toEqual([
      '',
      '    you  add a --json flag',
      '   read  src/list.ts  120 lines',
      '   grep  "json" in src  4 matches',
      '',
      '         Reusing printJson.',
    ]);
  });

  it('wraps a long message under the body column, by display width', () => {
    const text = '日本語のテキスト '.repeat(8).trim();
    const lines = plain([{ id: id(), kind: 'user', text }], 60);
    expect(lines[1]!.startsWith('    you  日本語')).toBe(true);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines.slice(2)) expect(line.startsWith('         ')).toBe(true);
  });

  it('cuts a word longer than the body', () => {
    const lines = plain([{ id: id(), kind: 'user', text: 'x'.repeat(130) }], 60);
    expect(lines.slice(1).map((line) => line.length)).toEqual([60, 60, 37]);
  });

  it('styles you in the accent colour with the message bold', () => {
    const [, row] = renderTranscript([{ id: id(), kind: 'user', text: 'hi' }], context(100)).lines;
    expect(row).toContain('\x1b[35m    you\x1b[39m');
    expect(row).toContain('\x1b[1mhi\x1b[22m');
  });
});

describe('thinking', () => {
  const thinking: ScrollbackEntry = {
    id: 'think1',
    kind: 'thinking',
    text: 'The list command lives in list.ts.\nCheck status.ts before adding a flag, and reuse whatever it does there.',
  };

  it('shows one clipped dim italic line', () => {
    const lines = plain([thinking], 60);
    expect(lines).toEqual(['  think  The list command lives in list.ts. Check status.ts…']);
    const [row] = renderTranscript([thinking], context(60)).lines;
    expect(row).toContain('\x1b[3m');
  });

  it('shows all of it when expanded', () => {
    const lines = plain([thinking], 60, { isExpanded: (entryId) => entryId === 'think1' });
    expect(lines).toEqual([
      '  think  The list command lives in list.ts.',
      '         Check status.ts before adding a flag, and reuse',
      '         whatever it does there.',
    ]);
  });
});

describe('tool rows', () => {
  const output = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
  const bash = tool({
    toolName: 'bash',
    text: 'pnpm vitest run (exit 1)',
    toolResult: { stdout: output, stderr: '', exit_code: 1 },
    durationMs: 4200,
  });

  it('marks a failed call and collapses its output to three rows', () => {
    expect(plain([bash], 100)).toEqual([
      ' ✗ bash  pnpm vitest run  exit 1 · 4.2s',
      '         line 1',
      '         line 2',
      '         line 3',
      '         … 5 more · ctrl+o',
    ]);
    const [header] = renderTranscript([bash], context(100)).lines;
    expect(header).toContain('\x1b[31m ✗ bash\x1b[39m');
    expect(header).toContain('\x1b[31mexit 1 · 4.2s\x1b[39m');
  });

  it('shows all output when expanded', () => {
    const lines = plain([bash], 100, { isExpanded: () => true });
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toBe('         line 8');
  });

  it('drops exit 0 from a successful command', () => {
    const ok = tool({
      toolName: 'bash',
      text: 'ls (exit 0)',
      toolResult: { stdout: 'a', stderr: '', exit_code: 0 },
      durationMs: 120,
    });
    expect(plain([ok], 100)).toEqual(['   bash  ls  0.1s', '         a']);
  });

  it('shows a spinner in the label of a running call', () => {
    const running = tool({ toolName: 'write', text: 'src/list.test.ts' });
    expect(plain([running], 100)).toEqual(['⠋ write  src/list.test.ts  writing…']);
  });

  it('names where a call ran when a Docker sandbox is active', () => {
    const lines = plain(
      [tool({ toolName: 'read', text: 'a.ts (3 lines)', toolResult: {}, toolTarget: 'sandbox' })],
      100,
      { sandboxActive: true },
    );
    expect(lines).toEqual(['   read  [sandbox] a.ts  3 lines']);
  });

  it('shortens a long or MCP tool name to fit the label column', () => {
    const lines = plain(
      [
        tool({ toolName: 'mcp__github__create_issue', text: 'title', toolResult: {} }),
        tool({
          toolName: 'mcp__burnlite__add_task',
          displayName: 'burnlite / add_task_to_project',
          text: 'project_id',
          toolResult: {},
        }),
        tool({ toolName: 'spawn_agent', displayName: 'explore', text: 'find it', toolResult: {} }),
      ],
      100,
    );
    expect(lines).toEqual([
      ' github  create_issue title',
      'burnli…  add_task_to_project project_id',
      'explore  find it',
    ]);
  });

  it('shows a tool error under the row', () => {
    const failed = tool({
      toolName: 'read',
      text: 'missing.ts',
      toolError: 'ENOENT: no such file',
    });
    expect(plain([failed], 100)).toEqual([' ✗ read  missing.ts', '         ENOENT: no such file']);
  });

  it('stacks the reads of an exploration group without gaps', () => {
    const members = [
      tool({ toolName: 'read', text: 'a.ts (1 lines)', toolResult: {} }),
      tool({ toolName: 'grep', text: 'x (2 matches)', toolResult: {} }),
    ];
    const lines = plain(
      [
        { id: id(), kind: 'explore', text: 'read 1 file · 1 search', members },
        tool({ toolName: 'read', text: 'b.ts (9 lines)', toolResult: {} }),
      ],
      100,
    );
    expect(lines).toEqual([
      '   read  a.ts  1 lines',
      '   grep  x  2 matches',
      '   read  b.ts  9 lines',
    ]);
  });

  it('clips a row to the width, keeping the facts', () => {
    const lines = plain(
      [tool({ toolName: 'read', text: `${'dir/'.repeat(30)}f.ts (3 lines)`, toolResult: {} })],
      60,
    );
    expect(lines[0]!.endsWith('…  3 lines')).toBe(true);
  });
});

describe('edits', () => {
  const edit = tool({
    toolName: 'edit',
    text: 'src/list.ts (1 replacement)',
    toolArgs: {
      old_string: '  const trees = readWorktrees();',
      new_string:
        '  const trees = readWorktrees(opts.root);\n  if (opts.json) return printJson(trees);',
    },
    toolResult: {
      startLine: 44,
      contextBefore: ['export function list(opts) {'],
      contextAfter: ['  const rows = trees.map(format);'],
    },
  });

  it('counts the change and numbers the diff rows', () => {
    expect(plain([edit], 100)).toEqual([
      '   edit  src/list.ts  +2 −1',
      '           43   export function list(opts) {',
      '           44 - const trees = readWorktrees();',
      '           44 + const trees = readWorktrees(opts.root);',
      '           45 + if (opts.json) return printJson(trees);',
      '           46   const rows = trees.map(format);',
    ]);
  });

  it('tints added and removed rows only when the theme sets the tints', () => {
    const untinted = renderTranscript([edit], context(100)).lines;
    expect(untinted.join('\n')).not.toContain('\x1b[48;');
    const tinted = renderTranscript(
      [edit],
      context(100, { style: createStyle(BUILTIN_THEMES.chimera, 'truecolor') }),
    ).lines;
    expect(tinted[2]).toContain('\x1b[48;2;61;35;41m');
    expect(tinted[3]).toContain('\x1b[48;2;33;56;38m');
    expect(tinted[1]).not.toContain('\x1b[48;');
    expect(stripAnsi(tinted[3]!)).toHaveLength(100);
  });
});

describe('assistant markdown', () => {
  it('separates paragraphs with a blank line and draws lists and code with a gutter', () => {
    const lines = plain(
      [
        {
          id: id(),
          kind: 'assistant',
          text: 'Added `--json`:\n\n- prints JSON\n- reuses printJson\n\n```ts\nif (opts.json) return printJson(trees);\n```\n\nDone.',
        },
      ],
      100,
    );
    expect(lines).toEqual([
      '',
      '         Added --json:',
      '',
      '         • prints JSON',
      '         • reuses printJson',
      '',
      '         ┆ if (opts.json) return printJson(trees);',
      '',
      '         Done.',
    ]);
  });

  it('colours inline code in the accent and code by syntax', () => {
    const [, row] = renderTranscript(
      [{ id: id(), kind: 'assistant', text: 'use `x`' }],
      context(100),
    ).lines;
    expect(row).toContain('\x1b[35mx\x1b[39m');
    const code = renderTranscript(
      [{ id: id(), kind: 'assistant', text: '```ts\nconst a = 1;\n```' }],
      context(100),
    ).lines.join('\n');
    expect(code).toContain('\x1b[35mconst\x1b[39m');
  });

  it('sizes a table by display width, wrapping cells to keep rows aligned', () => {
    const lines = plain(
      [
        {
          id: id(),
          kind: 'assistant',
          text: '| name | note |\n| --- | --- |\n| 日本 | a fairly long note that will need to wrap in a narrow terminal |\n| 😀 | ok |',
        },
      ],
      60,
    );
    const table = lines.slice(1);
    expect(table[0]!.trim().startsWith('┌')).toBe(true);
    expect(table.at(-1)!.trim().startsWith('└')).toBe(true);
    const widths = new Set(table.map((line) => displayWidth(line)));
    expect(widths.size).toBe(1);
    expect(table.some((line) => line.includes('日本'))).toBe(true);
    // A header row, then a body row that wrapped onto two lines and one that did not.
    expect(table).toHaveLength(7);
    expect(table[3]!.trim().startsWith('│ 日本 │ a fairly')).toBe(true);
    expect(table[4]!.trim().startsWith('│      │ wrap')).toBe(true);
  });

  it('keeps a long reply one entry, with no marker part-way through', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    const lines = plain([{ id: id(), kind: 'assistant', text }], 100);
    expect(lines.filter((line) => line.trim() !== '')).toHaveLength(30);
    expect(lines.every((line) => line === '' || line.startsWith('         Paragraph'))).toBe(true);
  });
});

describe('notices', () => {
  it('draws errors, goal results, compaction, mode changes and run summaries as rows', () => {
    expect(
      plain(
        [
          { id: id(), kind: 'error', text: 'send failed: boom' },
          { id: id(), kind: 'info', text: 'goal met: tests pass' },
          { id: id(), kind: 'info', text: 'compaction done: -1200 tokens' },
          { id: id(), kind: 'info', text: 'interrupt sent' },
          {
            id: id(),
            kind: 'mode_change',
            text: 'build → plan',
            modeFrom: 'build',
            modeTo: 'plan',
          },
          { id: id(), kind: 'turn', text: '12s · 3 steps' },
        ],
        100,
      ),
    ).toEqual([
      '✗ error  send failed: boom',
      '   goal  goal met: tests pass',
      'compact  compaction done: -1200 tokens',
      '   note  interrupt sent',
      '   mode  build → plan',
      '   done  12s · 3 steps',
    ]);
  });
});

describe('spans', () => {
  it('reports which lines each entry drew', () => {
    const entries: ScrollbackEntry[] = [
      { id: 'u', kind: 'user', text: 'hi' },
      { id: 't', kind: 'thinking', text: 'hmm' },
    ];
    expect(renderTranscript(entries, context(100)).spans).toEqual([
      { id: 'u', start: 0, end: 2 },
      { id: 't', start: 2, end: 3 },
    ]);
  });
});

describe('task row and banner', () => {
  it('draws the tasks as a compact row', () => {
    const row = renderTaskRow(
      [
        { content: 'locate', status: 'completed' },
        { content: 'add the option', status: 'completed' },
        { content: 'snapshot test', status: 'in_progress' },
        { content: 'readme', status: 'pending' },
      ],
      100,
      plainStyle,
    );
    expect(stripAnsi(row)).toBe('  tasks  2/4 ✓ ✓ ▸ snapshot test ○');
  });

  it('draws the banner as two dim rows', () => {
    const lines = renderBanner(
      {
        version: 'v1.2.3',
        modelRef: 'anthropic/claude',
        cwd: '/tmp/project',
        skillCount: 3,
        commandCount: 1,
      },
      100,
      plainStyle,
    ).map(stripAnsi);
    expect(lines).toEqual([
      'chimera  v1.2.3 · anthropic/claude · /tmp/project',
      '         3 skills · 1 command',
    ]);
  });
});

describe('every entry kind at 100 and 60 columns', () => {
  const session: ScrollbackEntry[] = [
    {
      id: 'a1',
      kind: 'user',
      text: 'fix the 日本語 parser 😀 and add a test please, it keeps failing on long inputs',
    },
    { id: 'a2', kind: 'thinking', text: 'Look at the parser first. '.repeat(10) },
    tool({ toolName: 'read', text: 'src/parser/日本.ts (300 lines)', toolResult: {} }),
    tool({
      toolName: 'bash',
      text: 'pnpm test (exit 0)',
      toolResult: { stdout: 'ok 😀 '.repeat(30), stderr: '', exit_code: 0 },
      durationMs: 900,
    }),
    {
      id: 'a3',
      kind: 'assistant',
      text: 'Fixed **both** cases in `parse()`:\n\n1. 日本語 input\n2. emoji 😀 input',
    },
    { id: 'a4', kind: 'info', text: 'goal met: the parser handles every input it is given' },
    { id: 'a5', kind: 'error', text: `stream error: ${'x'.repeat(120)}` },
    { id: 'a6', kind: 'turn', text: '1m 02s · 4 steps · 2 tool calls' },
  ];

  it.each([100, 60])('fits %i columns and keeps the label column', (width) => {
    const lines = plain(session, width);
    for (const line of lines) {
      if (line === '') continue;
      // Every row has a label in the first seven cells or starts in the body column.
      expect(line.slice(7, 9)).toBe('  ');
    }
    expect(lines.some((line) => line.includes('😀'))).toBe(true);
  });
});
