#!/usr/bin/env node
// PROTOTYPE, throwaway (CHIM-7 "Visual language for the transcript and prompt").
// Three structurally different looks for the same sample session, drawn in the real terminal
// so the colours, font and tmux behaviour are the ones the TUI will actually get.
//
//   A Bands   pi-style: full-width background bands for user and tool blocks, no glyphs,
//             prompt between two rules with the spinner in the top rule, two dim status rows
//   B Rail    foreground only: a coloured gutter bar per block, one-line tool summaries,
//             bare prompt under one rule, one status row
//   C Ledger  a right-aligned label column like a log; the prompt is a box whose borders
//             carry the mode, the activity and the status line. CHOSEN: assistant text has no
//             label, and diff rows borrow the tints from Bands.
//
// Run: node packages/tui/prototype/visual-language.mjs
// Keys: left/right or 1-3 variant, c colour mode, f inline/fullscreen, r running/idle,
//       e expand tool output, q quit.

const out = process.stdout;
const ESC = '\x1b[';

// ---------- colour ----------

const COLOUR_MODES = ['truecolor', '256', 'ansi16', 'none'];
const FG = {
  fg: { hex: '#dcdae4', ansi: '39' },
  muted: { hex: '#8b879c', ansi: '90' },
  dim: { hex: '#5e5a6e', ansi: '90' },
  accent: { hex: '#b79cf7', ansi: '35' },
  info: { hex: '#7aa7ff', ansi: '34' },
  success: { hex: '#8fd18b', ansi: '32' },
  error: { hex: '#f08a8a', ansi: '31' },
  warning: { hex: '#e6c46a', ansi: '33' },
};
const BG = {
  user: '#2b2838',
  tool: '#25242d',
  ok: '#1e2a23',
  err: '#321f26',
  code: '#1d1c24',
  add: '#213826',
  del: '#3d2329',
};

const state = {
  variant: 2,
  colour: /truecolor|24bit/i.test(process.env.COLORTERM ?? '') ? 'truecolor' : '256',
  layout: 'inline',
  running: true,
  expand: false,
  tick: 0,
};

function rgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function nearest256(hex) {
  const [r, g, b] = rgb(hex);
  const levels = [0, 95, 135, 175, 215, 255];
  const nearestLevel = (v) =>
    levels.reduce((best, level, i) => (Math.abs(level - v) < Math.abs(levels[best] - v) ? i : best), 0);
  const [qr, qg, qb] = [nearestLevel(r), nearestLevel(g), nearestLevel(b)];
  const cubeDistance = (levels[qr] - r) ** 2 + (levels[qg] - g) ** 2 + (levels[qb] - b) ** 2;
  const greyIndex = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const grey = 8 + greyIndex * 10;
  const greyDistance = (grey - r) ** 2 + (grey - g) ** 2 + (grey - b) ** 2;
  return greyDistance < cubeDistance ? 232 + greyIndex : 16 + 36 * qr + 6 * qg + qb;
}

function fg(token, text) {
  const spec = FG[token];
  switch (state.colour) {
    case 'truecolor':
      return `${ESC}38;2;${rgb(spec.hex).join(';')}m${text}${ESC}39m`;
    case '256':
      return `${ESC}38;5;${nearest256(spec.hex)}m${text}${ESC}39m`;
    case 'ansi16':
      return token === 'dim'
        ? `${ESC}2;90m${text}${ESC}22;39m`
        : `${ESC}${spec.ansi}m${text}${ESC}39m`;
    default:
      if (token === 'muted' || token === 'dim') return `${ESC}2m${text}${ESC}22m`;
      if (token === 'accent' || token === 'error') return `${ESC}1m${text}${ESC}22m`;
      return text;
  }
}

const bold = (text) => `${ESC}1m${text}${ESC}22m`;
const italic = (text) => `${ESC}3m${text}${ESC}23m`;

function bgOn(name) {
  if (state.colour === 'truecolor') return `${ESC}48;2;${rgb(BG[name]).join(';')}m`;
  if (state.colour === '256') return `${ESC}48;5;${nearest256(BG[name])}m`;
  return '';
}

const visibleLength = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;

function band(name, content, width) {
  const fill = ' '.repeat(Math.max(0, width - visibleLength(content)));
  const on = bgOn(name);
  return on ? `${on}${content}${fill}${ESC}49m` : content;
}

function leftRight(left, right, width) {
  const room = width - visibleLength(left) - visibleLength(right);
  return room >= 1 ? `${left}${' '.repeat(room)}${right}` : left;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines;
}

const inlineCode = (text) => text.replace(/`([^`]+)`/g, (_m, code) => fg('accent', code));
const highlight = (code) =>
  code
    .replace(/\b(if|return|const|export|function)\b/g, (k) => fg('accent', k))
    .replace(/\b(printJson|readWorktrees|formatWorktree)\b/g, (f) => fg('info', f));

/** Paragraphs, bullets and fenced code; `code` draws one finished code row. */
function markdown(text, width, indent, code) {
  const lines = [];
  let inCode = false;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) lines.push(code(raw));
    else if (raw === '') lines.push('');
    else if (raw.startsWith('- ')) {
      wrap(raw.slice(2), width - indent.length - 2).forEach((part, i) => {
        lines.push(`${indent}${i === 0 ? fg('muted', '• ') : '  '}${inlineCode(part)}`);
      });
    } else {
      for (const part of wrap(raw, width - indent.length)) lines.push(`${indent}${inlineCode(part)}`);
    }
  }
  return lines;
}

// ---------- the sample session ----------

const SESSION = [
  { kind: 'user', text: 'add a --json flag to `yg list` and cover it with a test' },
  {
    kind: 'thinking',
    text: 'The list command lives in src/yg/commands/list.ts. Other commands may already print JSON, so check status.ts before adding a flag, and reuse whatever it does.',
  },
  {
    kind: 'reads',
    items: [
      ['read', 'src/yg/commands/list.ts', '120 lines'],
      ['grep', '"json" in src/yg', '4 matches'],
      ['read', 'src/yg/commands/status.ts', '88 lines'],
    ],
  },
  { kind: 'assistant', text: '`status` already prints JSON through `printJson`, so `list` can reuse it.' },
  {
    kind: 'edit',
    path: 'src/yg/commands/list.ts',
    added: 2,
    removed: 1,
    diff: [
      [' ', 43, 'export function list(opts: ListOptions) {'],
      ['-', 44, '  const trees = readWorktrees();'],
      ['+', 44, '  const trees = readWorktrees(opts.root);'],
      ['+', 45, '  if (opts.json) return printJson(trees);'],
      [' ', 46, '  const rows = trees.map(formatWorktree);'],
    ],
  },
  {
    kind: 'bash',
    status: 'error',
    command: 'pnpm vitest run yg/list',
    meta: 'exit 1 · 4.2s',
    output: [
      'FAIL  test/list.test.ts > list > prints a table',
      'AssertionError: snapshot mismatch',
      '- Snapshot  -1',
      '+ Received  +1',
      '  main          ~/Projects/yggdrasil',
      '- json-flag     ~/w/json-flag',
      '+ yg/json-flag  ~/w/json-flag',
      ' Tests  1 failed | 13 passed (14)',
    ],
  },
  { kind: 'assistant', text: 'The table snapshot still has the old branch name. Updating it.' },
  {
    kind: 'bash',
    status: 'ok',
    command: 'pnpm vitest run yg/list -u',
    meta: '3.1s',
    output: ['✓ test/list.test.ts (14 tests) 212ms', ' Snapshots  1 updated', ' Tests  14 passed (14)'],
  },
];
const RUNNING_TAIL = [{ kind: 'write', path: 'src/yg/commands/list.test.ts' }];
const IDLE_TAIL = [
  {
    kind: 'assistant',
    text: 'Added `--json` to `yg list`:\n\n- prints the worktrees as a JSON array\n- reuses `printJson` from `status`\n\n```ts\nif (opts.json) return printJson(trees);\n```\n\nThe README still shows the old usage.',
  },
];
const TASKS = [
  ['done', 'locate the list command'],
  ['done', 'add the --json option'],
  ['active', 'snapshot test for the JSON shape'],
  ['todo', 'update README usage'],
];
const FACTS = {
  cwd: '~/Projects/yggdrasil',
  branch: 'yg/json-flag',
  session: '8AWWBRGC',
  mode: 'build',
  model: 'manticore/gpt-5',
  context: '38%/200k',
  tokens: '↑76k ↓3.7k',
  cost: '$0.42',
};

const blocks = () => [...SESSION, ...(state.running ? RUNNING_TAIL : IDLE_TAIL)];
const spinner = () => '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[state.tick % 10];
const outputLimit = (lines, max) =>
  state.expand || lines.length <= max ? { shown: lines, hidden: 0 } : { shown: lines.slice(0, max), hidden: lines.length - max };
const taskGlyph = { done: '✓', active: '▸', todo: '○' };
const taskTone = { done: 'success', active: 'accent', todo: 'dim' };

// ---------- A: Bands ----------

const bands = {
  name: 'Bands',
  transcript(width) {
    const lines = [];
    const box = (bg, rows) => {
      lines.push('', band(bg, '', width), ...rows.map((row) => band(bg, ` ${row}`, width)), band(bg, '', width));
    };
    for (const block of blocks()) {
      switch (block.kind) {
        case 'user':
          box('user', wrap(block.text, width - 2).map(inlineCode));
          break;
        case 'thinking': {
          const rows = wrap(block.text, width - 2);
          lines.push('', ...(state.expand ? rows : [clip(block.text, width - 2)]).map((row) => ` ${italic(fg('dim', row))}`));
          break;
        }
        case 'reads':
          box('ok', block.items.map(([tool, arg, meta]) => `${bold(tool)} ${arg}  ${fg('muted', meta)}`));
          break;
        case 'assistant':
          lines.push('', ...markdown(block.text, width, ' ', (code) => band('code', `   ${highlight(code)}`, width)));
          break;
        case 'edit': {
          const head = `${bold('edit')} ${block.path}  ${fg('success', `+${block.added}`)} ${fg('error', `−${block.removed}`)}`;
          lines.push('', band('ok', '', width), band('ok', ` ${head}`, width));
          for (const [sign, number, text] of block.diff) {
            const row = ` ${fg('dim', String(number).padStart(4))} ${sign === ' ' ? fg('muted', `  ${text}`) : fg(sign === '+' ? 'success' : 'error', `${sign} ${text}`)}`;
            lines.push(band(sign === '+' ? 'add' : sign === '-' ? 'del' : 'ok', row, width));
          }
          lines.push(band('ok', '', width));
          break;
        }
        case 'bash': {
          const bg = block.status === 'error' ? 'err' : 'ok';
          const { shown, hidden } = outputLimit(block.output, 4);
          const rows = [
            leftRight(bold(`$ ${block.command}`), fg(block.status === 'error' ? 'error' : 'muted', `${block.meta} `), width - 1),
            '',
            ...shown.map((row) => fg('muted', row)),
          ];
          if (hidden) rows.push(fg('dim', `… ${hidden} more lines, ctrl+o to expand`));
          box(bg, rows);
          break;
        }
        case 'write':
          box('tool', [`${bold('write')} ${block.path}  ${fg('muted', 'writing…')}`]);
          break;
      }
    }
    return lines;
  },
  chrome(width) {
    const lines = [];
    if (state.running) {
      for (const [status, name] of TASKS) lines.push(` ${fg(taskTone[status], taskGlyph[status])} ${fg(status === 'todo' ? 'dim' : 'muted', name)}`);
      lines.push('');
      const label = ` ${spinner()} Working · 12s · esc to interrupt `;
      lines.push(fg('accent', `──${label}${'─'.repeat(Math.max(0, width - 2 - label.length))}`));
      lines.push(` ${fg('dim', 'steer the agent, or tab to queue')}`);
    } else {
      lines.push('', fg('accent', '─'.repeat(width)));
      lines.push(` also update the README${ESC}7m ${ESC}27m`);
    }
    lines.push(fg('accent', '─'.repeat(width)));
    lines.push(fg('dim', ` ${FACTS.cwd} (${FACTS.branch}) • ${FACTS.session}`));
    lines.push(
      leftRight(
        fg('dim', ` ${FACTS.tokens} ${FACTS.cost} ${FACTS.context}`),
        fg('dim', `${FACTS.model} • ${FACTS.mode} `),
        width,
      ),
    );
    return lines;
  },
};

// ---------- B: Rail ----------

const rail = {
  name: 'Rail',
  transcript(width) {
    const lines = [];
    const bar = (tone) => `${fg(tone, '▎')} `;
    const toolHead = (tone, tool, arg, meta, metaTone = 'dim') =>
      leftRight(`${bar(tone)}${fg('muted', tool.padEnd(5))} ${arg}`, fg(metaTone, meta), width);
    let previous = null;
    for (const block of blocks()) {
      const isTool = ['reads', 'edit', 'bash', 'write'].includes(block.kind);
      const wasTool = previous && ['reads', 'edit', 'bash', 'write', 'thinking'].includes(previous.kind);
      if (!(isTool && wasTool)) lines.push('');
      previous = block;
      switch (block.kind) {
        case 'user':
          for (const row of wrap(block.text, width - 2)) lines.push(`${bar('accent')}${bold(inlineCode(row))}`);
          break;
        case 'thinking': {
          const rows = state.expand ? wrap(block.text, width - 2) : [clip(block.text, width - 2)];
          for (const row of rows) lines.push(`${bar('dim')}${italic(fg('dim', row))}`);
          break;
        }
        case 'reads':
          for (const [tool, arg, meta] of block.items) lines.push(toolHead('muted', tool, arg, meta));
          break;
        case 'assistant':
          lines.push(...markdown(block.text, width, '  ', (code) => `  ${fg('dim', '│')} ${highlight(code)}`));
          break;
        case 'edit':
          lines.push(toolHead('muted', 'edit', block.path, `${fg('success', `+${block.added}`)} ${fg('error', `−${block.removed}`)}`));
          for (const [sign, number, text] of block.diff) {
            const body = sign === ' ' ? fg('muted', `  ${text}`) : fg(sign === '+' ? 'success' : 'error', `${sign} ${text}`);
            lines.push(`${bar('muted')}  ${fg('dim', String(number).padStart(4))} ${body}`);
          }
          break;
        case 'bash': {
          const tone = block.status === 'error' ? 'error' : 'muted';
          lines.push(toolHead(tone, 'bash', block.command, block.meta, block.status === 'error' ? 'error' : 'dim'));
          const { shown, hidden } = outputLimit(block.output, 3);
          for (const row of shown) lines.push(`${bar(tone)}  ${fg('muted', row)}`);
          if (hidden) lines.push(`${bar(tone)}  ${fg('dim', `… ${hidden} more · ctrl+o`)}`);
          break;
        }
        case 'write':
          lines.push(leftRight(`${fg('warning', spinner())} ${fg('muted', 'write')} ${block.path}`, fg('dim', 'writing…'), width));
          break;
      }
    }
    return lines;
  },
  chrome(width) {
    const lines = [''];
    if (state.running) {
      const active = TASKS.find(([status]) => status === 'active');
      lines.push(
        leftRight(
          `${fg('warning', spinner())} ${fg('muted', `12s · step 6 · tasks 2/4 ▸ ${active[1]}`)}`,
          fg('dim', 'esc interrupt'),
          width,
        ),
      );
    }
    lines.push(fg('dim', '─'.repeat(width)));
    lines.push(state.running ? `${fg('accent', '›')} ${fg('dim', 'steer, or tab to queue')}` : `${fg('accent', '›')} also update the README${ESC}7m ${ESC}27m`);
    lines.push(
      leftRight(
        `${fg('accent', FACTS.mode)}${fg('dim', ` · ${FACTS.model} · ${FACTS.context} · ${FACTS.cost}`)}`,
        fg('dim', `${FACTS.cwd}  ${FACTS.branch}`),
        width,
      ),
    );
    return lines;
  },
};

// ---------- C: Ledger ----------

const LABEL_WIDTH = 7;
const ledger = {
  name: 'Ledger',
  transcript(width) {
    const lines = [];
    const label = (text, tone) => `${fg(tone, text.padStart(LABEL_WIDTH))}  `;
    const indent = ' '.repeat(LABEL_WIDTH + 2);
    const body = width - LABEL_WIDTH - 2;
    const labelled = (first, tone, rows) => rows.forEach((row, i) => lines.push(`${i === 0 ? label(first, tone) : indent}${row}`));
    for (const block of blocks()) {
      switch (block.kind) {
        case 'user':
          lines.push('');
          labelled('you', 'accent', wrap(block.text, body).map((row) => bold(inlineCode(row))));
          break;
        case 'thinking': {
          const rows = state.expand ? wrap(block.text, body) : [clip(block.text, body)];
          labelled('think', 'dim', rows.map((row) => italic(fg('dim', row))));
          break;
        }
        case 'reads':
          for (const [tool, arg, meta] of block.items) lines.push(`${label(tool, 'muted')}${arg}  ${fg('dim', meta)}`);
          break;
        case 'assistant': {
          lines.push('');
          const rows = markdown(block.text, body, '', (code) => `${fg('dim', '┆')} ${highlight(code)}`);
          for (const row of rows) lines.push(`${indent}${row}`);
          break;
        }
        case 'edit':
          lines.push(`${label('edit', 'muted')}${block.path}  ${fg('success', `+${block.added}`)} ${fg('error', `−${block.removed}`)}`);
          for (const [sign, number, text] of block.diff) {
            const code = sign === ' ' ? fg('muted', `  ${text}`) : fg(sign === '+' ? 'success' : 'error', `${sign} ${text}`);
            const row = `${indent}${fg('dim', String(number).padStart(4))} ${code}`;
            lines.push(sign === ' ' ? row : band(sign === '+' ? 'add' : 'del', row, width));
          }
          break;
        case 'bash': {
          const failed = block.status === 'error';
          lines.push(`${label(failed ? '✗ bash' : 'bash', failed ? 'error' : 'muted')}${block.command}  ${fg(failed ? 'error' : 'dim', block.meta)}`);
          const { shown, hidden } = outputLimit(block.output, 3);
          for (const row of shown) lines.push(`${indent}${fg('muted', row)}`);
          if (hidden) lines.push(`${indent}${fg('dim', `… ${hidden} more · ctrl+o`)}`);
          break;
        }
        case 'write':
          lines.push(`${label(`${spinner()} write`, 'warning')}${block.path}  ${fg('dim', 'writing…')}`);
          break;
      }
    }
    return lines;
  },
  chrome(width) {
    const lines = [''];
    if (state.running) {
      const summary = TASKS.map(([status, name]) =>
        status === 'active' ? fg('accent', `▸ ${name}`) : fg(taskTone[status], taskGlyph[status]),
      ).join(' ');
      lines.push(`${fg('dim', 'tasks'.padStart(LABEL_WIDTH))}  ${fg('muted', '2/4')} ${summary}`);
    }
    const edge = (left, right, corners) => {
      const fill = width - 2 - visibleLength(left) - visibleLength(right);
      return `${fg('muted', corners[0])}${left}${fg('muted', '─'.repeat(Math.max(0, fill)))}${right}${fg('muted', corners[1])}`;
    };
    const activity = state.running ? `${fg('muted', '─ ')}${fg('warning', spinner())}${fg('muted', ' 12s · esc interrupt ')}` : '';
    lines.push(edge(`${fg('muted', '─ ')}${fg('accent', FACTS.mode)} `, activity, ['╭', '╮']));
    const promptText = state.running ? fg('dim', 'steer, or tab to queue') : `also update the README${ESC}7m ${ESC}27m`;
    const inner = `${fg('accent', '›')} ${promptText}`;
    lines.push(`${fg('muted', '│')} ${inner}${' '.repeat(Math.max(0, width - 4 - visibleLength(inner)))} ${fg('muted', '│')}`);
    lines.push(
      edge(
        `${fg('muted', '─ ')}${fg('dim', `${FACTS.model} · ${FACTS.context} · ${FACTS.tokens} · ${FACTS.cost}`)} `,
        ` ${fg('dim', `${FACTS.cwd} · ${FACTS.branch}`)}${fg('muted', ' ─')}`,
        ['╰', '╯'],
      ),
    );
    return lines;
  },
};

const VARIANTS = [bands, rail, ledger];

// ---------- frame ----------

function frame() {
  const width = out.columns || 100;
  const rows = out.rows || 40;
  const height = rows - 1;
  const variant = VARIANTS[state.variant];
  const transcript = variant.transcript(width);
  const chrome = variant.chrome(width);
  let screen;
  if (state.layout === 'inline') {
    // What the terminal holds after the session scrolled by: the shell line, the transcript,
    // then the live chrome right under the last entry.
    const all = [fg('dim', '$ chimera'), ...transcript, ...chrome];
    screen = all.slice(-height);
    while (screen.length < height) screen.push('');
  } else {
    const room = height - chrome.length;
    let visible = transcript.slice(-room);
    const hidden = transcript.length - visible.length;
    if (hidden > 0) visible = [fg('dim', `  ▲ ${hidden} earlier lines · PgUp`), ...visible.slice(1)];
    while (visible.length < room) visible.push('');
    screen = [...visible, ...chrome];
  }
  const keys = `${state.variant + 1} ${variant.name}`;
  const proto = ` PROTOTYPE CHIM-7 │ ◀ ${keys} ▶ │ c ${state.colour} │ f ${state.layout} │ r ${state.running ? 'running' : 'idle'} │ e ${state.expand ? 'expanded' : 'collapsed'} │ q quit `;
  const bar = `${ESC}0;7m${proto.padEnd(width).slice(0, width)}${ESC}0m`;
  // Erase-to-end only on short rows: with autowrap off, a full row leaves the cursor on its
  // last cell, and erasing there would wipe that cell.
  const row = (line) => `${line}${ESC}0m${visibleLength(line) < width ? `${ESC}K` : ''}`;
  out.write(`${ESC}?2026h${ESC}H${screen.map(row).join('\r\n')}\r\n${bar}${ESC}?2026l`);
}

function quit() {
  out.write(`${ESC}0m${ESC}?25h${ESC}?7h${ESC}?1049l`);
  process.exit(0);
}

out.write(`${ESC}?1049h${ESC}?25l${ESC}?7l${ESC}2J`);
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const key of chunk.match(/\x1b\[[A-D]|[\s\S]/g) ?? []) handleKey(key);
  out.write(`${ESC}2J`);
  frame();
});
function handleKey(key) {
  if (key === 'q' || key === '\x03') quit();
  if (key === '\x1b[C') state.variant = (state.variant + 1) % VARIANTS.length;
  if (key === '\x1b[D') state.variant = (state.variant + VARIANTS.length - 1) % VARIANTS.length;
  if (/^[1-3]$/.test(key)) state.variant = Number(key) - 1;
  if (key === 'c') state.colour = COLOUR_MODES[(COLOUR_MODES.indexOf(state.colour) + 1) % COLOUR_MODES.length];
  if (key === 'f') state.layout = state.layout === 'inline' ? 'fullscreen' : 'inline';
  if (key === 'r') state.running = !state.running;
  if (key === 'e') state.expand = !state.expand;
}
out.on('resize', () => {
  out.write(`${ESC}2J`);
  frame();
});
setInterval(() => {
  if (!state.running) return;
  state.tick += 1;
  frame();
}, 80);
frame();
