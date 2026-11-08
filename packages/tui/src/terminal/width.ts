import stringWidth from 'string-width';

const ESC = '\x1b';
// CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), and two-byte escapes.
const ANSI_PATTERN = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  'g',
);

const segmenter = new Intl.Segmenter();

/** Cells `text` takes on screen. Escape sequences take none. */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** The text split into escape sequences and runs of printable text, in order. */
function tokens(text: string): Array<{ escape: boolean; value: string }> {
  const out: Array<{ escape: boolean; value: string }> = [];
  let last = 0;
  for (const match of text.matchAll(ANSI_PATTERN)) {
    if (match.index > last) out.push({ escape: false, value: text.slice(last, match.index) });
    out.push({ escape: true, value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ escape: false, value: text.slice(last) });
  return out;
}

/** The graphemes of plain text, each with its width. */
export function graphemes(text: string): Array<{ text: string; width: number }> {
  return Array.from(segmenter.segment(text), ({ segment }) => ({
    text: segment,
    width: stringWidth(segment),
  }));
}

/**
 * `text` cut to at most `width` cells, ending in `ellipsis` when cut. A
 * grapheme is never split, and every escape sequence is kept, so a style
 * still closes after the cut.
 */
export function clipToWidth(text: string, width: number, ellipsis = '…'): string {
  if (displayWidth(text) <= width) return text;
  const room = Math.max(0, width - displayWidth(ellipsis));
  let used = 0;
  let cut = false;
  let out = '';
  for (const token of tokens(text)) {
    if (token.escape) {
      out += token.value;
      continue;
    }
    if (cut) continue;
    for (const grapheme of graphemes(token.value)) {
      if (used + grapheme.width > room) {
        cut = true;
        break;
      }
      out += grapheme.text;
      used += grapheme.width;
    }
    if (cut) out += ellipsis;
  }
  return out;
}

/** `text` with spaces after it to fill `width` cells. */
export function padToWidth(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * The plain text in cells `[start, end)` of `text`. A wide character that
 * starts inside the range is kept whole.
 */
export function sliceColumns(text: string, start: number, end: number): string {
  let column = 0;
  let out = '';
  for (const grapheme of graphemes(stripAnsi(text))) {
    if (column >= end) break;
    if (column >= start) out += grapheme.text;
    column += grapheme.width;
  }
  return out;
}
