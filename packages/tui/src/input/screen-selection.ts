/** A cell of the screen: column and row, counted from zero. */
export interface Point {
  x: number;
  y: number;
}

/** The columns a selection may cover: `left` up to, not including, `right`. */
export interface Region {
  left: number;
  right: number;
}

export interface Selection {
  /** Where the button went down. */
  anchor: Point;
  /** Where the pointer is now. */
  focus: Point;
}

/** The selected cells of one row: `from` up to, not including, `to`. */
export interface RowSpan {
  row: number;
  from: number;
  to: number;
}

const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
// Colour and cursor sequences, and operating system commands (links, titles).
const ESCAPE_SEQUENCES = new RegExp(
  `${ESCAPE}\\[[0-9;?<>]*[A-Za-z~]|${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`,
  'g',
);
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const WIDE = /\p{Emoji_Presentation}|️/u;
const WIDE_RANGES: Array<[from: number, to: number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
];

function isWide(grapheme: string): boolean {
  if (WIDE.test(grapheme)) return true;
  const codePoint = grapheme.codePointAt(0) ?? 0;
  return WIDE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/**
 * What each column of a rendered line shows, without its colour codes. A
 * character two cells wide takes two entries: itself, then an empty string.
 */
export function screenCells(line: string): string[] {
  const cells: string[] = [];
  for (const { segment } of graphemes.segment(line.replace(ESCAPE_SEQUENCES, ''))) {
    cells.push(segment);
    if (isWide(segment)) cells.push('');
  }
  return cells;
}

function inReadingOrder(selection: Selection): [start: Point, end: Point] {
  const { anchor, focus } = selection;
  const anchorFirst = anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x);
  return anchorFirst ? [anchor, focus] : [focus, anchor];
}

/**
 * The cells a selection covers, row by row, the way a terminal selects: from
 * the first point to the end of its row, whole rows between, and the last
 * row up to the last point. Everything stays inside `region`.
 */
export function selectedRows(selection: Selection, region: Region): RowSpan[] {
  const [start, end] = inReadingOrder(selection);
  const clamp = (x: number) => Math.max(region.left, Math.min(region.right - 1, x));
  if (start.y === end.y) {
    return [{ row: start.y, from: clamp(start.x), to: clamp(end.x) + 1 }];
  }
  const rows: RowSpan[] = [{ row: start.y, from: clamp(start.x), to: region.right }];
  for (let row = start.y + 1; row < end.y; row += 1) {
    rows.push({ row, from: region.left, to: region.right });
  }
  rows.push({ row: end.y, from: region.left, to: clamp(end.x) + 1 });
  return rows;
}

/** Widen a span so that it does not cut a two-cell character in half. */
function wholeCharacters(cells: string[], span: RowSpan): RowSpan {
  const from = cells[span.from] === '' ? span.from - 1 : span.from;
  const to = cells[span.to] === '' ? span.to + 1 : span.to;
  return { row: span.row, from, to };
}
