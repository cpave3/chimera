import { marked, type Tokens } from 'marked';
import { highlightCode } from '../highlight';
import { displayWidth, graphemes, padToWidth } from '../terminal/width';
import type { Style } from '../theme/style';
import { type Run, wrapRuns, wrapText } from './text';

const TABLE_MIN_COLUMN = 4;
const CODE_GUTTER = '┆ ';

/**
 * Markdown as lines for a body column `width` cells wide: paragraphs,
 * headings, lists, block quotes, tables and code blocks, with one blank line
 * between blocks. Code keeps its shape: long code lines wrap under the gutter.
 */
export function renderMarkdown(text: string, width: number, style: Style): string[] {
  const blocks = marked.lexer(text).filter((token) => token.type !== 'space');
  const lines: string[] = [];
  blocks.forEach((block, index) => {
    if (index > 0) lines.push('');
    lines.push(...renderBlock(block as Tokens.Generic, width, style));
  });
  return lines;
}

function renderBlock(block: Tokens.Generic, width: number, style: Style): string[] {
  switch (block.type) {
    case 'paragraph':
      return wrapRuns(inlineRuns((block as Tokens.Paragraph).tokens ?? [], style), width);
    case 'heading': {
      const runs = inlineRuns((block as Tokens.Heading).tokens ?? [], style);
      return wrapRuns(
        runs.map((run) => ({
          ...run,
          paint: (value) => style.bold(style.fg('accent', run.paint ? run.paint(value) : value)),
        })),
        width,
      );
    }
    case 'list':
      return renderList(block as Tokens.List, width, style);
    case 'code':
      return renderCode(block as Tokens.Code, width, style);
    case 'blockquote': {
      const inner = renderMarkdown((block as Tokens.Blockquote).text, width - 2, style);
      return inner.map((line) => `${style.fg('dim', '│')} ${style.fg('muted', line)}`);
    }
    case 'hr':
      return [style.fg('dim', '─'.repeat(Math.min(width, 40)))];
    case 'table':
      return renderTable(block as Tokens.Table, width, style);
    case 'html':
      return wrapText((block as Tokens.HTML).text.trimEnd(), width);
    default:
      return wrapText(((block as { raw?: string }).raw ?? '').trimEnd(), width);
  }
}

function renderList(list: Tokens.List, width: number, style: Style): string[] {
  const start = typeof list.start === 'number' ? list.start : 1;
  const markers = list.items.map((_, index) => (list.ordered ? `${start + index}.` : '•'));
  const markerWidth = Math.max(...markers.map((marker) => displayWidth(marker))) + 1;
  const lines: string[] = [];
  list.items.forEach((item, index) => {
    const marker = style.fg('muted', padToWidth(markers[index]!, markerWidth));
    const hang = ' '.repeat(markerWidth);
    const body: string[] = [];
    for (const token of item.tokens ?? []) {
      if (token.type === 'text' || token.type === 'paragraph') {
        const inner = (token as Tokens.Text).tokens ?? [
          { type: 'text', raw: token.raw, text: (token as Tokens.Text).text },
        ];
        body.push(...wrapRuns(inlineRuns(inner as Tokens.Generic[], style), width - markerWidth));
      } else if (token.type !== 'space') {
        body.push(...renderBlock(token as Tokens.Generic, width - markerWidth, style));
      }
    }
    if (body.length === 0) body.push('');
    for (const [row, line] of body.entries()) lines.push(`${row === 0 ? marker : hang}${line}`);
  });
  return lines;
}

function renderCode(code: Tokens.Code, width: number, style: Style): string[] {
  const gutter = style.fg('dim', CODE_GUTTER);
  const room = Math.max(1, width - CODE_GUTTER.length);
  const highlighted = highlightCode(code.text, code.lang?.split(/\s/)[0]);
  const sourceLines = code.text.split('\n');
  const lines: string[] = [];
  sourceLines.forEach((source, index) => {
    const runs: Run[] = highlighted?.[index]?.map((segment) => ({
      text: segment.text,
      paint: segment.token ? (value: string) => style.fg(segment.token!, value) : undefined,
    })) ?? [{ text: source }];
    // Code keeps its spaces: wrap by cells, not between words.
    const wrapped = wrapCode(runs, room);
    for (const line of wrapped) lines.push(`${gutter}${line}`);
  });
  return lines;
}

/** Cut a line of code into pieces of `width` cells, keeping every space. */
function wrapCode(runs: Run[], width: number): string[] {
  const lines: string[] = [];
  let line = '';
  let used = 0;
  for (const run of runs) {
    let piece = '';
    const paint = (value: string) => (run.paint && value !== '' ? run.paint(value) : value);
    for (const grapheme of graphemes(run.text)) {
      if (used + grapheme.width > width && used > 0) {
        lines.push(line + paint(piece));
        line = '';
        piece = '';
        used = 0;
      }
      piece += grapheme.text;
      used += grapheme.width;
    }
    line += paint(piece);
  }
  lines.push(line);
  return lines;
}

function renderTable(table: Tokens.Table, width: number, style: Style): string[] {
  const header = table.header ?? [];
  const rows = table.rows ?? [];
  const columns = header.length || rows[0]?.length || 0;
  if (columns === 0) return [];
  const natural = Array.from({ length: columns }, (_, column) =>
    Math.max(
      1,
      displayWidth(header[column]?.text ?? ''),
      ...rows.map((row) => displayWidth(row[column]?.text ?? '')),
    ),
  );
  // │ cell │ cell │: one border per column, one more, and a space each side of a cell.
  const overhead = 1 + 3 * columns;
  const widths = distribute(natural, Math.max(columns * TABLE_MIN_COLUMN, width - overhead));
  const border = (left: string, middle: string, right: string) =>
    style.fg(
      'dim',
      left + widths.map((columnWidth) => '─'.repeat(columnWidth + 2)).join(middle) + right,
    );
  const bar = style.fg('dim', '│');
  const drawRow = (cells: Tokens.TableCell[], isHeader: boolean): string[] => {
    const wrapped = widths.map((columnWidth, column) => {
      const runs = inlineRuns(cells[column]?.tokens ?? [], style);
      const painted = isHeader
        ? runs.map((run) => ({
            ...run,
            paint: (value: string) => style.bold(run.paint ? run.paint(value) : value),
          }))
        : runs;
      return wrapRuns(painted, columnWidth);
    });
    const height = Math.max(1, ...wrapped.map((lines) => lines.length));
    return Array.from(
      { length: height },
      (_, line) =>
        `${bar}${wrapped.map((lines, column) => ` ${padToWidth(lines[line] ?? '', widths[column]!)} `).join(bar)}${bar}`,
    );
  };
  const lines = [border('┌', '┬', '┐')];
  if (header.length > 0) {
    lines.push(...drawRow(header, true));
    lines.push(border('├', '┼', '┤'));
  }
  for (const row of rows) lines.push(...drawRow(row, false));
  lines.push(border('└', '┴', '┘'));
  return lines;
}

/**
 * Column widths that fit `room`: natural when they fit, else the widest
 * column gives up a cell at a time, so short columns keep their words whole.
 */
function distribute(natural: number[], room: number): number[] {
  const widths = [...natural];
  let sum = widths.reduce((acc, value) => acc + value, 0);
  while (sum > room) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= TABLE_MIN_COLUMN) break;
    widths[widest]! -= 1;
    sum -= 1;
  }
  return widths;
}

/** Inline markdown as styled runs: bold, italic, code in the accent, links. */
export function inlineRuns(
  tokens: Tokens.Generic[],
  style: Style,
  outer?: (text: string) => string,
): Run[] {
  const runs: Run[] = [];
  const wrap = (inner: (text: string) => string) => (text: string) =>
    outer ? outer(inner(text)) : inner(text);
  for (const token of tokens) {
    switch (token.type) {
      case 'strong':
        runs.push(...inlineRuns((token as Tokens.Strong).tokens ?? [], style, wrap(style.bold)));
        break;
      case 'em':
        runs.push(...inlineRuns((token as Tokens.Em).tokens ?? [], style, wrap(style.italic)));
        break;
      case 'del':
        runs.push(...inlineRuns((token as Tokens.Del).tokens ?? [], style, wrap(style.dim)));
        break;
      case 'codespan':
        runs.push({
          text: decodeEntities((token as Tokens.Codespan).text),
          paint: wrap((value) => style.fg('accent', value)),
        });
        break;
      case 'link': {
        const link = token as Tokens.Link;
        runs.push(...inlineRuns(link.tokens ?? [], style, wrap(style.underline)));
        if (link.text !== link.href)
          runs.push({ text: ` (${link.href})`, paint: wrap((value) => style.fg('dim', value)) });
        break;
      }
      case 'br':
        runs.push({ text: '\n' });
        break;
      case 'text': {
        const inner = (token as Tokens.Text).tokens;
        if (inner && inner.length > 0)
          runs.push(...inlineRuns(inner as Tokens.Generic[], style, outer));
        else runs.push({ text: decodeEntities((token as Tokens.Text).text), paint: outer });
        break;
      }
      case 'escape':
        runs.push({ text: (token as Tokens.Escape).text, paint: outer });
        break;
      default:
        runs.push({ text: (token as { raw?: string }).raw ?? '', paint: outer });
    }
  }
  return runs;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}
