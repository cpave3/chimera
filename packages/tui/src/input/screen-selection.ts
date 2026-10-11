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

function leadingSpaces(text: string): number {
  return text.length - text.trimStart().length;
}

/**
 * The text of a selection. Trailing blanks of each row are padding, not
 * text. Rows after the first lose the indent the first row starts at, so
 * that code selected from its first character keeps its shape.
 */
export function selectedText(frameLines: string[], selection: Selection, region: Region): string {
  const spans = selectedRows(selection, region);
  const texts = spans.map((span) => {
    const cells = screenCells(frameLines[span.row] ?? '');
    const whole = wholeCharacters(cells, span);
    return cells.slice(whole.from, whole.to).join('').trimEnd();
  });
  const later = texts.slice(1).filter((text) => text !== '');
  const firstIndent = (spans[0]?.from ?? region.left) - region.left;
  const shared = Math.min(firstIndent, ...later.map(leadingSpaces));
  return [texts[0] ?? '', ...texts.slice(1).map((text) => text.slice(shared))].join('\n');
}

export interface ScreenSelectionOptions {
  /** Writes to the terminal, beside what the app itself draws. */
  write: (text: string) => void;
  /** The columns a selection that starts at this point may cover. */
  regionAt: (point: Point) => Region;
  /** Styles selected text. */
  highlight: (text: string) => string;
}

const SYNCHRONIZED_START = `${ESCAPE}[?2026h`;
const SYNCHRONIZED_END = `${ESCAPE}[?2026l`;
const RESET_TO_LINE_END = `${ESCAPE}[0m${ESCAPE}[K`;

function moveTo(row: number, column: number): string {
  return `${ESCAPE}[${row + 1};${column + 1}H`;
}

/**
 * Mouse selection on a screen the app draws itself. The app's renderer does
 * not know about the selection, so this paints the highlight over the app's
 * last frame and puts the frame's own rows back when the selection moves.
 */
export class ScreenSelection {
  private lines: string[] = [];
  private selection: Selection | null = null;
  private region: Region = { left: 0, right: 0 };
  private paintedRows = new Set<number>();

  constructor(private readonly options: ScreenSelectionOptions) {}

  /** True from a button press until the selection is cleared. */
  get active(): boolean {
    return this.selection !== null;
  }

  /** The app drew a frame. It wrote over part of the highlight, so paint it again. */
  frame(output: string): void {
    this.lines = output.split('\n');
    if (this.selection && this.paintedRows.size > 0) this.paint([]);
  }

  press(x: number, y: number): void {
    this.clear();
    this.region = this.options.regionAt({ x, y });
    this.selection = { anchor: { x, y }, focus: { x, y } };
  }

  drag(x: number, y: number): void {
    if (!this.selection) return;
    this.selection.focus = { x, y };
    this.paint([...this.paintedRows]);
  }

  /**
   * The button went up: the selected text, or null for a click without a
   * drag. The highlight stays until `clear`, so the user sees what was taken.
   */
  release(): string | null {
    const selection = this.selection;
    if (!selection) return null;
    if (selection.anchor.x === selection.focus.x && selection.anchor.y === selection.focus.y) {
      this.clear();
      return null;
    }
    const text = selectedText(this.lines, selection, this.region);
    return text.trim() === '' ? null : text;
  }

  /** Drop the selection and put the rows it covered back as the app drew them. */
  clear(): void {
    const rows = [...this.paintedRows];
    this.selection = null;
    this.paintedRows = new Set();
    if (rows.length > 0) this.options.write(this.restore(rows));
  }

  private restore(rows: number[]): string {
    const parts = rows.map(
      (row) => `${moveTo(row, 0)}${this.lines[row] ?? ''}${RESET_TO_LINE_END}`,
    );
    return `${SYNCHRONIZED_START}${parts.join('')}${SYNCHRONIZED_END}`;
  }

  private paint(staleRows: number[]): void {
    if (!this.selection) return;
    const parts = staleRows.map(
      (row) => `${moveTo(row, 0)}${this.lines[row] ?? ''}${RESET_TO_LINE_END}`,
    );
    this.paintedRows = new Set();
    for (const span of selectedRows(this.selection, this.region)) {
      const cells = screenCells(this.lines[span.row] ?? '');
      const whole = wholeCharacters(cells, span);
      // A row shorter than the span is blank there; the highlight still covers it.
      const text = Array.from({ length: whole.to - whole.from }, (_, offset) => {
        const cell = cells[whole.from + offset];
        return cell === undefined ? ' ' : cell;
      }).join('');
      parts.push(`${moveTo(span.row, whole.from)}${this.options.highlight(text)}`);
      this.paintedRows.add(span.row);
    }
    this.options.write(`${SYNCHRONIZED_START}${parts.join('')}${SYNCHRONIZED_END}`);
  }
}
