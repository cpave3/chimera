import { type Selection, screenCells, selectedRows } from '../input/screen-selection';
import type { InputEvent } from '../terminal/keys';
import { clipToWidth, displayWidth, stripAnsi } from '../terminal/width';
import type { Style } from '../theme/style';
import type { TranscriptScroller, TuiController } from './controller';
import { TranscriptView } from './transcript-view';

/** The search row's state while Ctrl+F is open. */
interface Search {
  query: string;
  /** Lines of the fully expanded transcript that hold the query, in order. */
  matches: Array<{ entryId: string | null; line: number }>;
  /** The match in view; -1 before the first Enter. */
  current: number;
}

const CODE_GUTTER = '┆ ';

function leadingSpaces(text: string): number {
  return text.length - text.trimStart().length;
}

/**
 * The text of a selection over transcript rows. Trailing blanks are padding.
 * The indent the selection starts in, and the indent later rows share with
 * the first row's text, are not text; a code block's gutter is not either,
 * so copied code keeps its shape.
 */
export function selectionText(rows: string[], selection: Selection, width: number): string {
  const spans = selectedRows(selection, { left: 0, right: width });
  const texts = spans.map((span) => {
    const cells = screenCells(rows[span.row] ?? '');
    const from = cells[span.from] === '' ? span.from - 1 : span.from;
    const to = cells[span.to] === '' ? span.to + 1 : span.to;
    return cells.slice(from, to).join('').trimEnd();
  });
  const first = texts[0] ?? '';
  const firstStart = (spans[0]?.from ?? 0) + leadingSpaces(first);
  const later = texts.slice(1);
  const shared = Math.min(firstStart, ...later.filter((text) => text !== '').map(leadingSpaces));
  let lines = [first.trimStart(), ...later.map((text) => text.slice(shared))];
  if (lines.slice(1).every((line) => line === '' || line.startsWith(CODE_GUTTER.trimEnd()))) {
    lines = lines.map((line) =>
      line.startsWith(CODE_GUTTER) ? line.slice(CODE_GUTTER.length) : line.replace(/^┆$/, ''),
    );
  }
  return lines.join('\n');
}

export type ReleaseResult =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'copy'; text: string }
  | null;

// The scrollbar's column at the right edge of the transcript.
const SCROLLBAR_COLUMNS = 1;

/**
 * The fullscreen layout: the transcript in a viewport that fills the
 * screen above the chrome (task row, card, prompt box and status line),
 * which stays pinned to the bottom. The viewport follows the newest output
 * until the user scrolls up; then new output does not move what they read.
 * It also owns what only the fullscreen layout has: the scrollbar, the
 * scroll indicators, mouse selection, click-to-expand and search.
 */
export class FullscreenLayout implements TranscriptScroller {
  readonly view = new TranscriptView();
  /** Lines scrolled up from the newest output; 0 follows it. */
  offset = 0;
  search: Search | null = null;
  private readonly searchView = new TranscriptView();
  private lastTotal = 0;
  private viewport = 1;
  /** The transcript line shown on the first viewport row. */
  private firstLine = 0;
  private transcriptWidth = 1;
  /** The transcript rows of the last frame, before overlays: what a selection copies. */
  private shownRows: string[] = [];
  private selection: Selection | null = null;
  private selectionTimer: NodeJS.Timeout | undefined;

  constructor(private readonly controller: TuiController) {
    controller.scroller = this;
  }

  get following(): boolean {
    return this.offset === 0;
  }

  frame(width: number, height: number, style: Style): string[] {
    const { controller } = this;
    const { entries, children } = controller.transcript();
    this.transcriptWidth = Math.max(10, width - SCROLLBAR_COLUMNS);
    const context = controller.rowContext(this.transcriptWidth, style, children);
    this.view.update(controller.banner(this.transcriptWidth, style), entries, context);
    if (this.search) this.findMatches(entries, context, style);
    const chrome = [...this.searchRow(width, style), ...controller.chrome(width, height, style)];
    this.viewport = Math.max(1, height - chrome.length);
    const total = this.view.lines.length;
    if (this.offset > 0 && total > this.lastTotal) this.offset += total - this.lastTotal;
    this.lastTotal = total;
    this.offset = Math.max(0, Math.min(this.offset, total - this.viewport));
    const end = total - this.offset;
    this.firstLine = Math.max(0, end - this.viewport);
    const rows = this.view.lines.slice(this.firstLine, end);
    while (rows.length < this.viewport) rows.push('');
    this.shownRows = rows;
    const drawn = rows.map((row, index) => this.overlay(row, index, style));
    if (this.firstLine > 0) {
      drawn[0] = style.fg('dim', `  ▲ ${this.firstLine} earlier lines · pgup`);
    }
    if (this.offset > 0 && this.viewport > 1) {
      drawn[drawn.length - 1] = style.fg(
        'dim',
        `  ▼ ${this.offset} newer lines · jump to latest · ctrl+end`,
      );
    }
    const bar = this.scrollbar(total, style);
    const transcript = drawn.map((row, index) => {
      const fitted =
        displayWidth(row) > this.transcriptWidth ? clipToWidth(row, this.transcriptWidth) : row;
      return `${fitted}${' '.repeat(Math.max(0, this.transcriptWidth - displayWidth(fitted)))}${bar[index] ?? ' '}`;
    });
    return [...transcript, ...chrome].slice(-height);
  }

  /** The thin track and thumb at the right edge; blank when everything fits. */
  scrollbar(total: number, style: Style): string[] {
    if (total <= this.viewport) return Array.from({ length: this.viewport }, () => ' ');
    const thumb = Math.max(1, Math.round((this.viewport * this.viewport) / total));
    const room = this.viewport - thumb;
    const lastFirst = total - this.viewport;
    const top = lastFirst === 0 ? 0 : Math.round((this.firstLine / lastFirst) * room);
    return Array.from({ length: this.viewport }, (_, row) =>
      row >= top && row < top + thumb ? style.fg('muted', '┃') : style.fg('dim', '│'),
    );
  }

  /** Selection and search highlights over one transcript row. */
  private overlay(row: string, index: number, style: Style): string {
    let painted = row;
    const query = this.search?.query;
    if (query) {
      const plain = stripAnsi(row);
      const lower = plain.toLowerCase();
      const needle = query.toLowerCase();
      if (lower.includes(needle)) {
        const currentMatch = this.search!.matches[this.search!.current];
        const isCurrent =
          currentMatch !== undefined && this.lineInView(currentMatch) === this.firstLine + index;
        let out = '';
        let from = 0;
        for (
          let at = lower.indexOf(needle);
          at >= 0;
          at = lower.indexOf(needle, at + needle.length)
        ) {
          out += plain.slice(from, at);
          const found = plain.slice(at, at + needle.length);
          out += isCurrent
            ? style.inverse(style.bold(style.fg('accent', found)))
            : style.inverse(found);
          from = at + needle.length;
        }
        painted = out + plain.slice(from);
      }
    }
    if (!this.selection) return painted;
    const span = selectedRows(this.selection, { left: 0, right: this.transcriptWidth }).find(
      (candidate) => candidate.row === index,
    );
    if (!span) return painted;
    const cells = screenCells(row);
    const before = cells.slice(0, span.from).join('');
    const chosen = Array.from(
      { length: span.to - span.from },
      (_, offset) => cells[span.from + offset] ?? ' ',
    ).join('');
    const after = cells.slice(span.to).join('');
    return `${before}${style.inverse(chosen)}${after}`;
  }

  /** The transcript was thrown away. */
  reset(): void {
    this.view.reset();
    this.searchView.reset();
    this.offset = 0;
    this.lastTotal = 0;
  }

  scrollBy(lines: number): void {
    this.offset = Math.max(0, this.offset - lines);
  }

  scrollPages(pages: number): void {
    this.scrollBy(pages * Math.max(1, this.viewport - 1));
  }

  toTop(): void {
    this.offset = Number.MAX_SAFE_INTEGER;
  }

  toEnd(): void {
    this.offset = 0;
  }

  // ---------- mouse ----------

  private inTranscript(x: number, y: number): boolean {
    return y >= 0 && y < this.viewport && x >= 0 && x < this.transcriptWidth;
  }

  press(x: number, y: number): void {
    this.clearSelection();
    if (!this.inTranscript(x, y)) return;
    this.selection = { anchor: { x, y }, focus: { x, y } };
  }

  drag(x: number, y: number): void {
    if (!this.selection) return;
    this.selection.focus = {
      x: Math.max(0, Math.min(this.transcriptWidth - 1, x)),
      y: Math.max(0, Math.min(this.viewport - 1, y)),
    };
  }

  /** The button went up: a click, a copy, or nothing. A copied selection stays lit for a moment. */
  release(onFade: () => void): ReleaseResult {
    const selection = this.selection;
    if (!selection) return null;
    const { anchor, focus } = selection;
    if (anchor.x === focus.x && anchor.y === focus.y) {
      this.selection = null;
      return { kind: 'click', x: anchor.x, y: anchor.y };
    }
    const text = selectionText(this.shownRows, selection, this.transcriptWidth);
    clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      this.selection = null;
      onFade();
    }, 1_200);
    this.selectionTimer.unref?.();
    return text.trim() === '' ? null : { kind: 'copy', text };
  }

  clearSelection(): void {
    clearTimeout(this.selectionTimer);
    this.selection = null;
  }

  /** A click on a tool call or a thought shows or hides just that entry. */
  click(x: number, y: number): void {
    if (!this.inTranscript(x, y)) return;
    const entryId = this.view.entryAt(this.firstLine + y);
    if (!entryId) return;
    const entry = this.controller.scrollback.all().find((candidate) => candidate.id === entryId);
    if (entry?.kind === 'tool' || entry?.kind === 'thinking') this.controller.toggleEntry(entryId);
  }

  // ---------- search ----------

  /** Keys for search: Ctrl+F opens it; while open it has the keyboard. True when it took the key. */
  handleKey(event: InputEvent): boolean {
    if (event.type === 'paste' && this.search) {
      this.setQuery(this.search.query + event.text.replace(/\n/g, ' '));
      return true;
    }
    if (event.type !== 'key') return false;
    if (!this.search) {
      if (event.ctrl && event.name === 'f' && !this.controller.modalCard()) {
        this.search = { query: '', matches: [], current: -1 };
        return true;
      }
      return false;
    }
    const search = this.search;
    if (event.name === 'escape') {
      this.search = null;
    } else if (event.name === 'enter') {
      this.step(event.shift ? -1 : 1);
    } else if (event.ctrl && (event.name === 'p' || event.name === 'n')) {
      this.step(event.name === 'p' ? -1 : 1);
    } else if (event.name === 'backspace') {
      this.setQuery(search.query.slice(0, -1));
    } else if (event.text !== undefined) {
      this.setQuery(search.query + event.text);
    } else if (event.name === 'pageup' || event.name === 'pagedown') {
      this.scrollPages(event.name === 'pageup' ? -1 : 1);
    }
    return true;
  }

  private setQuery(query: string): void {
    this.search = { query, matches: [], current: -1 };
  }

  private searchRow(width: number, style: Style): string[] {
    const search = this.search;
    if (!search) return [];
    const position =
      search.query === ''
        ? ''
        : search.matches.length === 0
          ? 'no matches'
          : `${search.current < 0 ? '–' : search.current + 1}/${search.matches.length}`;
    const keys = 'enter next · shift+enter prev · esc';
    const left = `${style.fg('dim', '   find')}  ${style.fg('accent', '›')} ${search.query}${style.inverse(' ')}`;
    const right = style.fg('dim', [position, keys].filter(Boolean).join(' · '));
    const gap = Math.max(2, width - displayWidth(left) - displayWidth(right));
    return [clipToWidth(`${left}${' '.repeat(gap)}${right}`, width)];
  }

  /** Every line holding the query, in the transcript with every entry expanded. */
  private findMatches(
    entries: Parameters<TranscriptView['update']>[1],
    context: Parameters<TranscriptView['update']>[2],
    style: Style,
  ): void {
    const search = this.search!;
    if (search.query === '') return;
    this.searchView.update(this.controller.banner(this.transcriptWidth, style), entries, {
      ...context,
      isExpanded: () => true,
      spinner: '',
    });
    const needle = search.query.toLowerCase();
    const matches: Search['matches'] = [];
    this.searchView.lines.forEach((line, index) => {
      if (stripAnsi(line).toLowerCase().includes(needle)) {
        matches.push({ entryId: this.searchView.entryAt(index), line: index });
      }
    });
    search.matches = matches;
    if (search.current >= matches.length) search.current = matches.length - 1;
  }

  /** Where a match of the expanded transcript is in the transcript on screen. */
  private lineInView(match: Search['matches'][number]): number {
    if (match.entryId === null) return match.line;
    const inSearch = this.searchView.spans.find((span) => span.id === match.entryId);
    const inView = this.view.spans.find((span) => span.id === match.entryId);
    if (!inSearch || !inView) return match.line;
    const offsetInEntry = match.line - (inSearch.start + this.searchView.headerRows);
    return (
      inView.start + this.view.headerRows + Math.min(offsetInEntry, inView.end - inView.start - 1)
    );
  }

  private step(direction: 1 | -1): void {
    const search = this.search;
    if (!search || search.matches.length === 0) return;
    const count = search.matches.length;
    search.current =
      search.current < 0
        ? direction === 1
          ? count - 1
          : 0
        : (search.current + (direction === 1 ? -1 : 1) + count) % count;
    const match = search.matches[search.current]!;
    // A match inside collapsed output opens that entry.
    if (match.entryId && !this.controller.isExpanded(match.entryId)) {
      const entry = this.controller.scrollback
        .all()
        .find((candidate) => candidate.id === match.entryId);
      if (entry?.kind === 'tool' || entry?.kind === 'thinking')
        this.controller.expandedOverrides.set(match.entryId, true);
    }
    this.pendingReveal = match;
  }

  private pendingReveal: Search['matches'][number] | null = null;

  /** After a frame laid out the entry a match opened, bring the match into view. */
  revealPending(): boolean {
    const match = this.pendingReveal;
    if (!match) return false;
    this.pendingReveal = null;
    const line = this.lineInView(match);
    const total = this.view.lines.length;
    const firstLine = Math.max(
      0,
      Math.min(total - this.viewport, line - Math.floor(this.viewport / 2)),
    );
    this.offset = Math.max(0, total - this.viewport - firstLine);
    return true;
  }

  /** The text of the whole transcript as the user last saw it, for the exit print. */
  exitLines(width: number, style: Style): string[] {
    const { entries, children } = this.controller.transcript();
    const view = new TranscriptView();
    view.update(this.controller.banner(width, style), entries, {
      ...this.controller.rowContext(width, style, children),
      spinner: '○',
    });
    return view.lines;
  }
}
