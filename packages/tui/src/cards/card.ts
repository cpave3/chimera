import type { InputEvent } from '../terminal/keys';
import { clipToWidth, displayWidth } from '../terminal/width';
import type { ColorToken } from '../theme/palette';
import type { Style } from '../theme/style';

/**
 * A dialog or picker drawn as a card above the prompt box. A card keeps its
 * state in plain fields and reads them on every key, so keys typed in a
 * burst act in order.
 */
export interface Card {
  /** Rows to draw for `width` columns, at most `maxRows` of them. */
  render(width: number, maxRows: number, style: Style): string[];
  handleKey(event: InputEvent): void;
  /** Scroll a card taller than its rows; false when all of it is in view. */
  scroll?(lines: number): boolean;
  /** PgUp/PgDn: scroll by the card's own page; false when all of it is in view. */
  scrollPages?(pages: number): boolean;
}

export interface CardFrame {
  title: string;
  tone: ColorToken;
  /** The working keys, on the right of the top border. */
  keys?: string;
  /** Rows that stay in view at the top. */
  header?: string[];
  /** Rows that scroll when the card is too tall for its rows. */
  body?: string[];
  /** Rows that stay in view at the bottom, such as the choices. */
  footer?: string[];
}

export interface CardScroll {
  /** The first body row in view; null follows the end of the body. */
  top: number | null;
}

// The top and bottom borders.
const FRAME_ROWS = 2;

/** Rows a card's text may use inside its border and padding. */
export function cardInnerWidth(width: number): number {
  return Math.max(4, width - 4);
}

/**
 * Draw a square-cornered full-width card: the title in its tone and the keys
 * on the top border, rows inside. When the card is taller than `maxRows`,
 * the body scrolls between the header and the footer, with a row saying
 * which lines are in view.
 */
export function renderCard(
  frame: CardFrame,
  width: number,
  maxRows: number,
  style: Style,
  scroll: CardScroll = { top: 0 },
): string[] {
  const inner = cardInnerWidth(width);
  const header = frame.header ?? [];
  const body = frame.body ?? [];
  const footer = frame.footer ?? [];
  let shownBody = body;
  let position: string | null = null;
  const fixed = FRAME_ROWS + header.length + footer.length;
  if (fixed + body.length > maxRows && body.length > 0) {
    const room = Math.max(1, maxRows - fixed - 1);
    const lastTop = Math.max(0, body.length - room);
    const top = Math.min(scroll.top ?? lastTop, lastTop);
    scroll.top = scroll.top === null ? null : top;
    shownBody = body.slice(top, top + room);
    position = `lines ${top + 1}–${top + shownBody.length} of ${body.length} · pgup/pgdn`;
  }
  const muted = (text: string) => style.fg('muted', text);
  const title = `${muted('─ ')}${style.fg(frame.tone, frame.title)} `;
  const keys = frame.keys ? ` ${style.fg('dim', frame.keys)}${muted(' ─')}` : '';
  const fill = Math.max(1, width - 2 - displayWidth(title) - displayWidth(keys));
  const top = `${muted('┌')}${title}${muted('─'.repeat(fill))}${keys}${muted('┐')}`;
  const row = (content: string) => {
    const clipped = displayWidth(content) > inner ? clipToWidth(content, inner) : content;
    return `${muted('│')} ${clipped}${' '.repeat(Math.max(0, inner - displayWidth(clipped)))} ${muted('│')}`;
  };
  const lines = [top, ...header.map(row), ...shownBody.map(row)];
  if (position) lines.push(row(style.fg('dim', position)));
  lines.push(...footer.map(row));
  lines.push(`${muted('└')}${muted('─'.repeat(Math.max(0, width - 2)))}${muted('┘')}`);
  return lines.map((line) => (displayWidth(line) > width ? clipToWidth(line, width) : line));
}

/** Move a card's scroll position; false when the body fits. */
export function scrollCard(
  scroll: CardScroll,
  lines: number,
  bodyRows: number,
  room: number,
): boolean {
  const lastTop = bodyRows - room;
  if (lastTop <= 0) return false;
  const current = Math.min(scroll.top ?? lastTop, lastTop);
  scroll.top = Math.max(0, Math.min(lastTop, current + lines));
  return true;
}

/** A choice row: the marker on the highlighted one, its key, its label. */
export function choiceRow(
  highlighted: boolean,
  key: string,
  label: string,
  tone: ColorToken,
  style: Style,
  detail?: string,
): string {
  const marker = highlighted ? style.fg('accent', '› ') : '  ';
  const text = highlighted ? style.bold(label) : label;
  return `${marker}${style.fg(tone, key.padEnd(2))} ${text}${detail ? `  ${style.fg('dim', detail)}` : ''}`;
}

/** Text on one row: line breaks shown as `↵`. */
export function oneLine(text: string): string {
  return text.replace(/\r?\n/g, '↵');
}

/**
 * A row of text being typed inside a card, with the cursor at its end. Text
 * longer than the row keeps its end in view, where the typing happens.
 */
export function inputRow(
  label: string,
  text: string,
  style: Style,
  width = Number.POSITIVE_INFINITY,
): string {
  const lead = `${label} › `;
  const room = Math.max(1, width - displayWidth(lead) - 1);
  let shown = oneLine(text);
  if (displayWidth(shown) > room) {
    const kept: string[] = [];
    let used = 1;
    for (const grapheme of [...new Intl.Segmenter().segment(shown)]
      .map((part) => part.segment)
      .reverse()) {
      const cells = displayWidth(grapheme);
      if (used + cells > room) break;
      kept.unshift(grapheme);
      used += cells;
    }
    shown = `…${kept.join('')}`;
  }
  return `${style.fg('muted', label)} ${style.fg('accent', '›')} ${shown}${style.inverse(' ')}`;
}

/** A labelled fact row: `label  value`, the label padded to `labelWidth`. */
export function factRow(label: string, value: string, labelWidth: number, style: Style): string {
  return `${style.fg('muted', label.padEnd(labelWidth))}  ${value}`;
}
