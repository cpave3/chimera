#!/usr/bin/env node
// PROTOTYPE, throwaway (CHIM-11 "Dialogs and pickers in the new look").
// Three ways to fit dialogs and pickers into the chosen Ledger look (CHIM-7):
//
//   A In the log     the request is a ledger row in the transcript; choices are a one-line
//                    key strip; pickers list under the prompt box
//   B In the box     the prompt box itself becomes the dialog or picker: its borders name it
//                    and hold the hints, its body holds the choices
//   C Card above     a separate bordered card above the prompt box; the prompt box stays
//
// Run: node packages/tui/prototype/dialogs.mjs
// Keys: left/right or 1-3 variant, s next surface, up/down move, c colour, q quit.

const out = process.stdout;
const ESC = '\x1b[';

const PALETTE = { muted: '90', dim: '2;90', accent: '35', info: '34', success: '32', error: '31', warning: '33' };
const HEX = {
  muted: '#8b879c', dim: '#5e5a6e', accent: '#b79cf7', info: '#7aa7ff',
  success: '#8fd18b', error: '#f08a8a', warning: '#e6c46a',
};
const state = { variant: 0, surface: 0, selected: 0, colour: 'default', tick: 0 };

function fg(token, text) {
  if (state.colour === 'chimera') {
    const n = Number.parseInt(HEX[token].slice(1), 16);
    return `${ESC}38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}${ESC}39m`;
  }
  return `${ESC}${PALETTE[token]}m${text}${ESC}22;39m`;
}
const bold = (text) => `${ESC}1m${text}${ESC}22m`;
const inverse = (text) => `${ESC}7m${text}${ESC}27m`;
const vlen = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
const pad = (text, width) => `${text}${' '.repeat(Math.max(0, width - vlen(text)))}`;
function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines;
}
const LABEL = 7;
const label = (text, tone) => `${fg(tone, text.padStart(LABEL))}  `;
const indent = ' '.repeat(LABEL + 2);

function edge(left, right, corners, width) {
  const fill = width - 2 - vlen(left) - vlen(right);
  return `${fg('muted', corners[0])}${left}${fg('muted', '─'.repeat(Math.max(0, fill)))}${right}${fg('muted', corners[1])}`;
}
const boxRow = (inner, width) => `${fg('muted', '│')} ${pad(inner, width - 4)} ${fg('muted', '│')}`;
const spinner = () => '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[state.tick % 10];
const statusBorder = (width) =>
  edge(`${fg('muted', '─ ')}${fg('dim', 'manticore/gpt-5 · 38%/200k')} `, ` ${fg('dim', '~/Projects/yggdrasil · yg/json-flag')}${fg('muted', ' ─')}`, ['╰', '╯'], width);
const statusBelow = () => `   ${fg('dim', '8AWWBRGC · os sandbox')}`;

// ---------- surfaces ----------

const PERMISSION = {
  name: 'Permission request',
  tool: 'bash',
  command: 'git push origin yg/json-flag',
  reason: 'network access: pushes to github.com',
  verdict: 'System One: needs review (writes outside the project)',
  choices: [
    ['a', 'Allow once', 'success'],
    ['A', 'Allow & remember…', 'success'],
    ['g', 'Allow pattern…', 'success'],
    ['d', 'Deny once', 'error'],
    ['f', 'Deny with feedback…', 'error'],
  ],
};
const QUESTION = {
  name: 'Question',
  header: 'Snapshot',
  text: 'The table snapshot changed because the branch name now has a prefix. Update the snapshot or keep the old name?',
  choices: [
    ['1', 'Update the snapshot', 'fg'],
    ['2', 'Keep the old branch name', 'fg'],
    ['3', 'Type an answer…', 'fg'],
  ],
};
const SLASH = {
  name: 'Slash menu',
  typed: '/re',
  choices: [
    ['/rewind', 'Go back to an earlier message'],
    ['/reload', 'Read commands and instruction files again'],
    ['/review', 'Review the changes since main (command)'],
    ['/research', 'Investigate a question (skill)'],
  ],
};
const SESSIONS = {
  name: 'Session picker',
  choices: [
    ['8AWWBRGC', 'add a --json flag to yg list', '2m ago', '14 msgs'],
    ['3KQ1ZP0D', 'fix the flaky worktree test', '1h ago', '42 msgs'],
    ['Q9V7M2XA', 'explain the plan command', 'yesterday', '6 msgs'],
    ['L0D4C8EE', 'release notes for 0.4', '3d ago', '21 msgs'],
  ],
};
const SURFACES = [PERMISSION, QUESTION, SLASH, SESSIONS];

const TRANSCRIPT = [
  `${label('you', 'accent')}${bold('push the branch and open a PR')}`,
  `${label('bash', 'muted')}git status --short  ${fg('dim', '0.1s')}`,
  '',
  `${indent}The working tree is clean. Pushing the branch now.`,
];

const choiceTone = (tone, text) => (tone === 'fg' ? text : fg(tone, text));

// ---------- A: In the log ----------

function variantA(width, surface) {
  const lines = [...TRANSCRIPT];
  const promptBox = (top, body) => [
    edge(top, '', ['╭', '╮'], width),
    boxRow(body, width),
    statusBorder(width),
  ];
  if (surface === PERMISSION) {
    lines.push(`${label('allow?', 'warning')}${bold(`bash  ${surface.command}`)}`);
    lines.push(`${indent}${fg('muted', surface.reason)}`);
    lines.push(`${indent}${fg('dim', surface.verdict)}`);
    const items = surface.choices.map(([key, text, tone], i) =>
      i === state.selected ? inverse(` ${key} ${text} `) : ` ${fg(tone, key)} ${text} `,
    );
    let strip = '';
    for (const item of items) {
      if (strip && vlen(strip) + vlen(item) + 1 > width - indent.length) {
        lines.push(`${indent}${strip}`);
        strip = item;
      } else strip = strip ? `${strip}${fg('dim', '·')}${item}` : item;
    }
    lines.push(`${indent}${strip}`);
    lines.push('', ...promptBox(`${fg('muted', '─ ')}${fg('warning', 'approval')} `, fg('dim', 'press a key, or ←/→ and enter')), statusBelow());
  } else if (surface === QUESTION) {
    lines.push(`${label('asks', 'info')}${fg('dim', `${surface.header} · 1 of 1`)}`);
    for (const row of wrap(surface.text, width - indent.length)) lines.push(`${indent}${row}`);
    surface.choices.forEach(([key, text], i) => {
      lines.push(`${indent}${i === state.selected ? fg('accent', '›') : ' '} ${fg('muted', `${key}.`)} ${i === state.selected ? bold(text) : text}`);
    });
    lines.push('', ...promptBox(`${fg('muted', '─ ')}${fg('info', 'answer')} `, fg('dim', '1-3, or type your own answer')), statusBelow());
  } else {
    lines.push('', ...promptBox(`${fg('muted', '─ ')}${fg('accent', 'build')} `, `${fg('accent', '›')} ${surface === SLASH ? surface.typed : fg('dim', '/sessions')}${inverse(' ')}`));
    lines.push(...pickerRows(surface, width, '   '));
  }
  return lines;
}

function pickerRows(surface, width, lead) {
  return surface.choices.map((choice, i) => {
    const marker = i === state.selected ? fg('accent', '› ') : '  ';
    if (surface === SLASH) {
      const [name, help] = choice;
      return `${lead}${marker}${i === state.selected ? bold(name.padEnd(12)) : name.padEnd(12)}${fg('dim', help)}`;
    }
    const [id, title, when, count] = choice;
    const left = `${lead}${marker}${fg('dim', id)}  ${i === state.selected ? bold(title) : title}`;
    const right = fg('dim', `${when} · ${count}  `);
    return `${left}${' '.repeat(Math.max(1, width - vlen(left) - vlen(right)))}${right}`;
  });
}

// ---------- B: In the box ----------

function variantB(width, surface) {
  const lines = [...TRANSCRIPT, ''];
  const rows = [];
  let title;
  let hints;
  if (surface === PERMISSION) {
    title = `${fg('warning', 'allow bash?')}`;
    hints = fg('dim', 'a/A/g/d/f or ↑↓ enter');
    rows.push(bold(surface.command), fg('muted', surface.reason), fg('dim', surface.verdict), '');
    surface.choices.forEach(([key, text, tone], i) => {
      rows.push(`${i === state.selected ? fg('accent', '›') : ' '} ${fg(tone, key)}  ${i === state.selected ? bold(text) : text}`);
    });
  } else if (surface === QUESTION) {
    title = fg('info', `question · ${surface.header}`);
    hints = fg('dim', '1-3 or ↑↓ enter · type to answer');
    rows.push(...wrap(surface.text, width - 4), '');
    surface.choices.forEach(([key, text], i) => {
      rows.push(`${i === state.selected ? fg('accent', '›') : ' '} ${fg('muted', `${key}.`)} ${i === state.selected ? bold(text) : text}`);
    });
  } else {
    title = fg('accent', surface === SLASH ? 'commands' : 'sessions');
    hints = fg('dim', '↑↓ move · tab complete · esc close');
    rows.push(`${fg('accent', '›')} ${surface === SLASH ? surface.typed : 'json'}${inverse(' ')}`, '');
    rows.push(...pickerRows(surface, width - 4, ''));
  }
  lines.push(edge(`${fg('muted', '─ ')}${title} `, ` ${hints}${fg('muted', ' ─')}`, ['╭', '╮'], width));
  for (const row of rows) lines.push(boxRow(row, width));
  lines.push(statusBorder(width), statusBelow());
  return lines;
}

// ---------- C: Card above ----------

function variantC(width, surface) {
  const lines = [...TRANSCRIPT, ''];
  const cardWidth = width;
  const card = (title, rows, hint) => {
    lines.push(edge(`${fg('muted', '─ ')}${title} `, hint ? ` ${hint}${fg('muted', ' ─')}` : '', ['┌', '┐'], cardWidth));
    for (const row of rows) lines.push(boxRow(row, cardWidth));
    lines.push(`${fg('muted', '└')}${fg('muted', '─'.repeat(cardWidth - 2))}${fg('muted', '┘')}`);
  };
  if (surface === PERMISSION) {
    const rows = [`${fg('muted', 'bash')}  ${bold(surface.command)}`, `${fg('muted', 'why ')}  ${surface.reason}`, `${fg('muted', 'check')} ${fg('dim', surface.verdict)}`, ''];
    const cols = surface.choices.map(([key, text, tone], i) =>
      i === state.selected ? inverse(` ${key} ${text} `) : ` ${fg(tone, key)} ${text} `,
    );
    rows.push(cols.slice(0, 3).join('  '), cols.slice(3).join('  '));
    card(fg('warning', 'approval needed'), rows, fg('dim', 'key or ←/→ enter'));
  } else if (surface === QUESTION) {
    const rows = [...wrap(surface.text, cardWidth - 4), ''];
    surface.choices.forEach(([key, text], i) => rows.push(`${i === state.selected ? fg('accent', '›') : ' '} ${fg('muted', `${key}.`)} ${i === state.selected ? bold(text) : text}`));
    card(fg('info', `question · ${surface.header}`), rows, fg('dim', '1-3 · type to answer'));
  } else {
    card(fg('accent', surface === SLASH ? 'commands' : 'sessions'), pickerRows(surface, cardWidth - 4, ''), fg('dim', '↑↓ · tab · esc'));
  }
  const promptText = surface === SLASH ? `${surface.typed}${inverse(' ')}` : surface === SESSIONS ? `/sessions${inverse(' ')}` : fg('dim', 'waiting for your answer above');
  lines.push(edge(`${fg('muted', '─ ')}${fg('accent', 'build')} `, '', ['╭', '╮'], width), boxRow(`${fg('accent', '›')} ${promptText}`, width), statusBorder(width), statusBelow());
  return lines;
}

const VARIANTS = [
  ['In the log', variantA],
  ['In the box', variantB],
  ['Card above', variantC],
];

function frame() {
  const width = Math.min(out.columns || 100, 110);
  const rows = out.rows || 40;
  const surface = SURFACES[state.surface];
  const [name, draw] = VARIANTS[state.variant];
  const body = draw(width, surface);
  const screen = body.slice(-(rows - 1));
  while (screen.length < rows - 1) screen.unshift('');
  const proto = ` PROTOTYPE CHIM-11 │ ◀ ${state.variant + 1} ${name} ▶ │ s ${surface.name} │ ↑↓ move │ c ${state.colour} │ q quit `;
  const bar = `${ESC}0;7m${proto.padEnd(out.columns || 100).slice(0, out.columns || 100)}${ESC}0m`;
  const row = (line) => `${line}${ESC}0m${vlen(line) < (out.columns || 100) ? `${ESC}K` : ''}`;
  out.write(`${ESC}?2026h${ESC}H${screen.map(row).join('\r\n')}\r\n${bar}${ESC}?2026l`);
}

function handleKey(key) {
  if (key === 'q' || key === '\x03') {
    out.write(`${ESC}0m${ESC}?25h${ESC}?7h${ESC}?1049l`);
    process.exit(0);
  }
  if (key === '\x1b[C') state.variant = (state.variant + 1) % VARIANTS.length;
  if (key === '\x1b[D') state.variant = (state.variant + VARIANTS.length - 1) % VARIANTS.length;
  if (/^[1-3]$/.test(key)) state.variant = Number(key) - 1;
  if (key === 's') {
    state.surface = (state.surface + 1) % SURFACES.length;
    state.selected = 0;
  }
  const count = SURFACES[state.surface].choices.length;
  if (key === '\x1b[B') state.selected = (state.selected + 1) % count;
  if (key === '\x1b[A') state.selected = (state.selected + count - 1) % count;
  if (key === 'c') state.colour = state.colour === 'default' ? 'chimera' : 'default';
}

out.write(`${ESC}?1049h${ESC}?25l${ESC}?7l${ESC}2J`);
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const key of chunk.match(/\x1b\[[A-D]|[\s\S]/g) ?? []) handleKey(key);
  out.write(`${ESC}2J`);
  frame();
});
out.on('resize', () => {
  out.write(`${ESC}2J`);
  frame();
});
setInterval(() => {
  state.tick += 1;
}, 80);
frame();
