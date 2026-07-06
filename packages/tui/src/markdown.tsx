import { Box, Text } from 'ink';
import { marked, type Tokens } from 'marked';
import React from 'react';
import type { Theme } from './theme/types';

/** Floor for a table column when the table is too wide for the terminal. */
const TABLE_MIN_COL_WIDTH = 6;

export function renderMarkdown(text: string, theme: Theme, width = 120): React.ReactElement[] {
  const tokens = marked.lexer(text).filter((t) => t.type !== 'space');
  return tokens.map((tok, i) => renderBlock(tok, theme, i, i > 0, width));
}

function renderBlock(
  tok: Tokens.Generic,
  theme: Theme,
  key: number,
  topGap: boolean,
  width: number,
): React.ReactElement {
  const gap = topGap ? 1 : 0;
  if (tok.type === 'paragraph') {
    const inline = (tok as Tokens.Paragraph).tokens ?? [];
    return (
      <Box key={key} marginTop={gap}>
        <Text>{renderInline(inline, theme)}</Text>
      </Box>
    );
  }
  if (tok.type === 'table') {
    return renderTable(tok as Tokens.Table, theme, key, gap, width);
  }
  if (tok.type === 'list') {
    const l = tok as Tokens.List;
    const start = typeof l.start === 'number' ? l.start : 1;
    return (
      <Box key={key} flexDirection="column" paddingLeft={2} marginTop={gap}>
        {l.items.map((item, i) => {
          const marker = l.ordered ? `${start + i}.` : '•';
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for list items
            <Box key={i}>
              <Text color={theme.text.muted}>{marker} </Text>
              <Text>{renderInline(itemInlineTokens(item), theme)}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }
  if (tok.type === 'code') {
    const codeToken = tok as Tokens.Code;
    const lines = codeToken.text.split('\n');
    return (
      <Box key={key} flexDirection="column" paddingLeft={2} marginTop={gap}>
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for code lines
          <Text key={i} color={theme.accent.secondary} dimColor>
            {line.length === 0 ? ' ' : line}
          </Text>
        ))}
      </Box>
    );
  }
  if (tok.type === 'heading') {
    const h = tok as Tokens.Heading;
    return (
      <Box key={key} marginTop={gap}>
        <Text bold color={theme.ui.accent}>
          {renderInline(h.tokens ?? [], theme)}
        </Text>
      </Box>
    );
  }
  return (
    <Box key={key} marginTop={gap}>
      <Text>{(tok as { raw?: string }).raw ?? ''}</Text>
    </Box>
  );
}

/**
 * Render a GFM table as a bordered grid. Each cell is a fixed-width `<Box>`
 * containing `<Text wrap>` with the cell's inline-formatted content, so rows
 * grow taller (more visual lines) rather than wider when content overflows.
 * Columns that don't fit the terminal are shrunk proportionally with a
 * minimum floor, trading height for width.
 */
function renderTable(
  tok: Tokens.Table,
  theme: Theme,
  key: number,
  gap: number,
  width: number,
): React.ReactElement {
  const headerCells = tok.header ?? [];
  const bodyRows = tok.rows ?? [];
  const numCols = headerCells.length || (bodyRows[0]?.length ?? 0);

  // Natural width per column: longest cell plain-text (header or body). We
  // measure `cell.text` (markdown-stripped) rather than the rendered nodes
  // so bold/code markers don't inflate the width.
  const natural: number[] = [];
  for (let col = 0; col < numCols; col++) {
    let widest = headerCells[col]?.text.length ?? 0;
    for (const row of bodyRows) {
      widest = Math.max(widest, row[col]?.text.length ?? 0);
    }
    natural.push(widest);
  }

  // Layout: │ content │ content │ — each column contributes colWidth + 3
  // chars (space, content, space, │) plus the leading │.
  const borderOverhead = 1 + 3 * numCols;
  const availContent = Math.max(numCols * TABLE_MIN_COL_WIDTH, width - borderOverhead);
  const colWidths = distributeColumnWidths(natural, availContent, TABLE_MIN_COL_WIDTH);

  const border = theme.text.muted;
  const topBorder = borderLine('┌', '┬', '┐', colWidths);
  const midBorder = borderLine('├', '┼', '┤', colWidths);
  const bottomBorder = borderLine('└', '┴', '┘', colWidths);

  return (
    <Box key={key} flexDirection="column" marginTop={gap}>
      <Text color={border}>{topBorder}</Text>
      {headerCells.length > 0 && (
        <TableRow
          cells={headerCells}
          colWidths={colWidths}
          isHeader
          accent={theme.ui.accent}
          border={border}
          theme={theme}
        />
      )}
      <Text color={border}>{midBorder}</Text>
      {bodyRows.map((row, i) => (
        <TableRow
          // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for body rows
          key={i}
          cells={row}
          colWidths={colWidths}
          isHeader={false}
          accent={theme.ui.accent}
          border={border}
          theme={theme}
        />
      ))}
      <Text color={border}>{bottomBorder}</Text>
    </Box>
  );
}

function TableRow({
  cells,
  colWidths,
  isHeader,
  accent,
  border,
  theme,
}: {
  cells: Tokens.TableCell[];
  colWidths: number[];
  isHeader: boolean;
  accent: string;
  border: string;
  theme: Theme;
}): React.ReactElement {
  // Pre-wrap each cell's plain text to its column width to determine the
  // row height. Ink's <Text wrap> does the actual visual wrapping of the
  // formatted content; this count only sizes the border columns so the │
  // separators stretch to match the tallest cell.
  const cellLineCounts = colWidths.map((w, col) => wrapCellCount(cells[col]?.text ?? '', w));
  const rowHeight = Math.max(1, ...cellLineCounts);
  const borderCol = (
    <Box key="border" width={1}>
      <Text color={border}>{'│\n'.repeat(rowHeight).slice(0, -1)}</Text>
    </Box>
  );
  const cols: React.ReactNode[] = [borderCol];
  for (let col = 0; col < colWidths.length; col++) {
    const cell = cells[col];
    const w = colWidths[col] ?? 1;
    cols.push(
      <Box key={`c${col}`} width={w + 2}>
        <Text bold={isHeader} color={isHeader ? accent : undefined} wrap="wrap">
          {' '}
          {renderInline(cell?.tokens ?? [], theme)}{' '}
        </Text>
      </Box>,
    );
    cols.push(
      <Box key={`s${col}`} width={1}>
        <Text color={border}>{'│\n'.repeat(rowHeight).slice(0, -1)}</Text>
      </Box>,
    );
  }
  return <Box>{cols}</Box>;
}

function borderLine(left: string, mid: string, right: string, colWidths: number[]): string {
  return left + colWidths.map((w) => '─'.repeat(w + 2)).join(mid) + right;
}

/**
 * Distribute `availContent` columns across the table. If the natural widths
 * already fit, use them as-is (no wrapping). Otherwise shrink each column
 * proportionally to its natural width, enforcing a minimum floor, then
 * adjust the totals to land exactly on `availContent`.
 */
function distributeColumnWidths(
  natural: number[],
  availContent: number,
  minWidth: number,
): number[] {
  if (natural.length === 0) return [];
  const sumNatural = natural.reduce((a, b) => a + b, 0);
  if (sumNatural <= availContent) return natural.map((w) => Math.max(1, w));
  const widths = natural.map((w) =>
    Math.max(minWidth, Math.floor((w / sumNatural) * availContent)),
  );
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > availContent) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= minWidth) break;
    widths[widest]--;
    total--;
  }
  while (total < availContent) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest]++;
    total++;
  }
  return widths.map((w) => Math.max(1, w));
}

/** Count how many visual lines `text` occupies when wrapped to `width`. */
function wrapCellCount(text: string, width: number): number {
  const w = Math.max(1, width);
  let count = 0;
  for (const para of text.split('\n')) {
    if (para.length === 0) {
      count++;
      continue;
    }
    let lineLen = 0;
    let lines = 1;
    for (const word of para.split(' ')) {
      const add = lineLen === 0 ? word.length : lineLen + 1 + word.length;
      if (add <= w) {
        lineLen = add;
      } else {
        lines++;
        if (word.length > w) {
          lines += Math.floor(word.length / w) - 1;
          lineLen = word.length % w || w;
        } else {
          lineLen = word.length;
        }
      }
    }
    count += lines;
  }
  return Math.max(1, count);
}

function itemInlineTokens(item: Tokens.ListItem): Tokens.Generic[] {
  const out: Tokens.Generic[] = [];
  for (const t of item.tokens ?? []) {
    const inner = (t as { tokens?: Tokens.Generic[] }).tokens;
    if (inner && inner.length > 0) out.push(...inner);
    else out.push(t as Tokens.Generic);
  }
  return out;
}

function renderInline(tokens: Tokens.Generic[], theme: Theme): React.ReactNode[] {
  return tokens.map((tok, i) => renderInlineToken(tok, theme, i));
}

function renderInlineToken(tok: Tokens.Generic, theme: Theme, key: number): React.ReactNode {
  if (tok.type === 'text') {
    return <React.Fragment key={key}>{(tok as Tokens.Text).text}</React.Fragment>;
  }
  if (tok.type === 'strong') {
    return (
      <Text key={key} bold>
        {renderInline((tok as Tokens.Strong).tokens ?? [], theme)}
      </Text>
    );
  }
  if (tok.type === 'em') {
    return (
      <Text key={key} italic>
        {renderInline((tok as Tokens.Em).tokens ?? [], theme)}
      </Text>
    );
  }
  if (tok.type === 'codespan') {
    return (
      <Text key={key} color={theme.accent.secondary}>
        {(tok as Tokens.Codespan).text}
      </Text>
    );
  }
  return <React.Fragment key={key}>{(tok as { raw?: string }).raw ?? ''}</React.Fragment>;
}
