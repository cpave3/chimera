import { formatElapsed } from '../activity';
import type { MultilineBuffer } from '../input/buffer';
import { clipToWidth, displayWidth, graphemes } from '../terminal/width';
import type { ColorValue } from '../theme/palette';
import type { Style } from '../theme/style';
import { BELOW_INDENT, type StatusLine } from './status-line';

export interface PromptBoxState {
  mode: { name: string; color?: ColorValue; pending?: { name: string; color?: ColorValue } };
  /** Set while a run or a compaction is in progress. */
  activity: { spinner: string; elapsedMs: number; label?: string } | null;
  buffer: MultilineBuffer;
  /** A card above has the keyboard. */
  waiting: boolean;
  /** Hide the cursor: an editor has the buffer. */
  editorOpen?: boolean;
  /** Replaces the keys on the top border for a moment, e.g. `copied 12 characters`. */
  notice?: string | null;
  /** The keys on the top border; the default depends on whether a run is active. */
  keys?: string;
  statusLine: StatusLine;
}

/** Rows of input the box shows before it scrolls with the cursor. */
const MAX_INPUT_ROWS = 10;
const MARKER = '› ';
const BANG_MARKER = '$ ';
const CONTINUATION = '  ';
// `@path`, `#path`, `[Pasted text #n, m lines]` and `[Image #n]`.
const TOKEN = /([@#][^\s]+)|(\[Pasted text #\d+, \d+ lines\]|\[Image #\d+\])/g;

function edge(
  left: string,
  right: string,
  corners: [string, string],
  width: number,
  style: Style,
): string {
  const fill = Math.max(1, width - 2 - displayWidth(left) - displayWidth(right));
  return `${style.fg('muted', corners[0])}${left}${style.fg('muted', '─'.repeat(fill))}${right}${style.fg('muted', corners[1])}`;
}

/** Paint the input: attachments in the info colour, paste markers muted, the cursor inverse. */
function paintInput(text: string, cursor: number | null, style: Style): string {
  const spans: Array<{ start: number; end: number; tone: 'info' | 'muted' }> = [];
  for (const match of text.matchAll(TOKEN)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      tone: match[1] ? 'info' : 'muted',
    });
  }
  let out = '';
  let offset = 0;
  const pieces: Array<{ text: string; tone?: 'info' | 'muted'; cursor?: boolean }> = [];
  for (const grapheme of graphemes(text)) {
    const span = spans.find((candidate) => offset >= candidate.start && offset < candidate.end);
    pieces.push({ text: grapheme.text, tone: span?.tone, cursor: cursor === offset });
    offset += grapheme.text.length;
  }
  if (cursor !== null && cursor >= text.length) pieces.push({ text: ' ', cursor: true });
  // Group runs of the same tone so each gets one pair of escape codes.
  let run = '';
  let runTone: 'info' | 'muted' | undefined;
  const flush = () => {
    if (run !== '') out += runTone ? style.fg(runTone, run) : run;
    run = '';
  };
  for (const piece of pieces) {
    if (piece.cursor) {
      flush();
      out += style.inverse(piece.text);
      continue;
    }
    if (piece.tone !== runTone) flush();
    runTone = piece.tone;
    run += piece.text;
  }
  flush();
  return out;
}

/** Cut a line of input into rows of `width` cells; returns each row's start offset too. */
function wrapInput(line: string, width: number): Array<{ text: string; start: number }> {
  const rows: Array<{ text: string; start: number }> = [];
  let text = '';
  let start = 0;
  let used = 0;
  let offset = 0;
  for (const grapheme of graphemes(line)) {
    if (used + grapheme.width > width && text !== '') {
      rows.push({ text, start });
      text = '';
      start = offset;
      used = 0;
    }
    text += grapheme.text;
    used += grapheme.width;
    offset += grapheme.text.length;
  }
  rows.push({ text, start });
  return rows;
}

/**
 * The prompt box: a rounded box with the mode, the activity and the keys
 * that matter on its top border, the input inside, the status line's first
 * row in its bottom border and its other rows dim under it.
 */
export function renderPromptBox(state: PromptBoxState, width: number, style: Style): string[] {
  const inner = Math.max(4, width - 4);
  const lines: string[] = [];

  const mode = style.color(state.mode.color ?? style.tokens.accent, state.mode.name);
  const pending = state.mode.pending
    ? `${style.fg('muted', ' → ')}${style.color(state.mode.pending.color ?? style.tokens.accent, state.mode.pending.name)}`
    : '';
  const topLeft = `${style.fg('muted', '─ ')}${mode}${pending} `;
  const keys = state.keys ?? (state.activity ? 'esc interrupt · tab queue' : '? help');
  let topRight: string;
  if (state.notice) {
    topRight = ` ${style.fg('success', state.notice)} ${style.fg('muted', '─')}`;
  } else if (state.activity) {
    const facts = [
      formatElapsed(state.activity.elapsedMs),
      ...(state.activity.label ? [state.activity.label] : []),
      keys,
    ];
    topRight = ` ${style.fg('warning', state.activity.spinner)} ${style.fg('muted', facts.join(' · '))} ${style.fg('muted', '─')}`;
  } else {
    topRight = ` ${style.fg('dim', keys)} ${style.fg('muted', '─')}`;
  }
  const roomForRight = width - 2 - displayWidth(topLeft) - 1;
  if (displayWidth(topRight) > roomForRight)
    topRight = clipToWidth(topRight, Math.max(0, roomForRight));
  lines.push(edge(topLeft, topRight, ['╭', '╮'], width, style));

  const side = style.fg('muted', '│');
  const row = (content: string) => {
    const pad = Math.max(0, inner - displayWidth(content));
    return `${side} ${content}${' '.repeat(pad)} ${side}`;
  };
  if (state.waiting) {
    lines.push(
      row(`${style.fg('accent', MARKER)}${style.fg('dim', 'waiting for your answer above')}`),
    );
  } else {
    const { text, cursor } = state.buffer;
    const bang = text.startsWith('!');
    const marker = style.fg(bang ? 'info' : 'accent', bang ? BANG_MARKER : MARKER);
    const rows: string[] = [];
    let cursorRow = 0;
    let lineStart = 0;
    text.split('\n').forEach((line, lineIndex) => {
      for (const piece of wrapInput(line, inner - MARKER.length)) {
        const absoluteStart = lineStart + piece.start;
        const absoluteEnd = absoluteStart + piece.text.length;
        const isLastPiece = piece.start + piece.text.length === line.length;
        const hasCursor =
          !state.editorOpen &&
          cursor >= absoluteStart &&
          (cursor < absoluteEnd || (isLastPiece && cursor === absoluteEnd));
        if (hasCursor) cursorRow = rows.length;
        const lead = rows.length === 0 ? marker : CONTINUATION;
        rows.push(
          `${lead}${paintInput(piece.text, hasCursor ? cursor - absoluteStart : null, style)}`,
        );
      }
      lineStart += line.length + 1;
      if (lineIndex === 0 && rows.length === 0) rows.push(marker);
    });
    // A tall message scrolls inside the box to keep the cursor in view.
    const first = Math.max(
      0,
      Math.min(cursorRow - MAX_INPUT_ROWS + 1, rows.length - MAX_INPUT_ROWS),
    );
    for (const shown of rows.slice(first, first + MAX_INPUT_ROWS)) lines.push(row(shown));
  }

  const { border, below } = state.statusLine;
  const bottomLeft = border.left
    ? `${style.fg('muted', '─ ')}${border.left} `
    : style.fg('muted', '─');
  const bottomRight = border.right ? ` ${border.right}${style.fg('muted', ' ─')}` : '';
  lines.push(edge(bottomLeft, bottomRight, ['╰', '╯'], width, style));
  for (const extra of below)
    lines.push(clipToWidth(`${BELOW_INDENT}${style.fg('dim', extra)}`, width));
  return lines;
}
