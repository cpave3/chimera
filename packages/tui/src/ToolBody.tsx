import { Box, Text } from 'ink';
import React from 'react';
import { lineDiff } from './diff';
import type { ScrollbackEntry, ToolEntry } from './scrollback';
import type { Theme } from './theme/types';

export const TOOL_BODY_LIMITS = {
  editDiffLines: 40,
  writeContentLines: 30,
  bashStdoutLines: 20,
  bashStderrLines: 10,
} as const;

export interface ToolBodyProps {
  width: number;
  prefixLen: number;
  theme: Theme;
}

export function renderToolBody(entry: ScrollbackEntry, ctx: ToolBodyProps): React.ReactElement[] {
  if (entry.kind !== 'tool') return [];
  if (entry.toolError) return [];
  switch (entry.toolName) {
    case 'edit':
      return renderEditBody(entry, ctx);
    case 'write':
      return renderWriteBody(entry, ctx);
    case 'bash':
      return renderBashBody(entry, ctx);
    default:
      return [];
  }
}

type EditHunkResult = {
  startLine?: number;
  contextBefore?: string[];
  contextAfter?: string[];
};

type HunkRow =
  | { kind: 'same' | 'del' | 'add'; lineNumber: number; content: string }
  | { kind: 'sep'; count: number };

function renderEditBody(
  entry: ToolEntry,
  { width, prefixLen, theme }: ToolBodyProps,
): React.ReactElement[] {
  const args = entry.toolArgs as { old_string?: string; new_string?: string } | undefined;
  if (!args) return [];
  const result = entry.toolResult as EditHunkResult | undefined;
  if (!result || typeof result.startLine !== 'number') {
    return renderEditBodyLegacy(args, { width, prefixLen, theme });
  }

  const oldLines = args.old_string ? stripTrailingNewline(args.old_string).split('\n') : [];
  const newLines = args.new_string ? stripTrailingNewline(args.new_string).split('\n') : [];
  const before = result.contextBefore ?? [];
  const after = result.contextAfter ?? [];
  const startLine = result.startLine;

  const rows: HunkRow[] = [];
  before.forEach((line, idx) => {
    rows.push({ kind: 'same', lineNumber: startLine - before.length + idx, content: line });
  });

  const diff = lineDiff(oldLines, newLines);
  let oldOffset = 0;
  let newOffset = 0;
  for (const entryDiff of diff) {
    if (entryDiff.kind === 'same') {
      rows.push({
        kind: 'same',
        lineNumber: startLine + newOffset,
        content: entryDiff.line,
      });
      oldOffset += 1;
      newOffset += 1;
    } else if (entryDiff.kind === 'del') {
      rows.push({
        kind: 'del',
        lineNumber: startLine + oldOffset,
        content: entryDiff.line,
      });
      oldOffset += 1;
    } else {
      rows.push({
        kind: 'add',
        lineNumber: startLine + newOffset,
        content: entryDiff.line,
      });
      newOffset += 1;
    }
  }

  const lastBodyLine = startLine + newOffset;
  after.forEach((line, idx) => {
    rows.push({ kind: 'same', lineNumber: lastBodyLine + idx, content: line });
  });

  const cap = TOOL_BODY_LIMITS.editDiffLines;
  let truncated = 0;
  let visible: HunkRow[] = rows;
  if (rows.length > cap) {
    visible = rows.slice(0, cap);
    truncated = rows.length - cap;
  }
  if (truncated > 0) visible.push({ kind: 'sep', count: truncated });

  const maxLineNumber = visible.reduce(
    (acc, row) => (row.kind === 'sep' ? acc : Math.max(acc, row.lineNumber)),
    0,
  );
  const gutterWidth = String(maxLineNumber).length + 1;
  const innerWidth = bodyInnerWidth(width, prefixLen, gutterWidth + 2);

  return visible.map((row, i) => {
    if (row.kind === 'sep') {
      return moreLinesRow(`d${i}`, row.count, prefixLen, theme);
    }
    return hunkRow(`d${i}`, row, gutterWidth, innerWidth, prefixLen, theme);
  });
}

function renderEditBodyLegacy(
  args: { old_string?: string; new_string?: string },
  { width, prefixLen, theme }: ToolBodyProps,
): React.ReactElement[] {
  const oldLines = args.old_string ? stripTrailingNewline(args.old_string).split('\n') : [];
  const newLines = args.new_string ? stripTrailingNewline(args.new_string).split('\n') : [];
  const cap = TOOL_BODY_LIMITS.editDiffLines;
  const total = oldLines.length + newLines.length;
  const innerWidth = bodyInnerWidth(width, prefixLen, 2);

  const rows: React.ReactElement[] = [];
  let key = 0;
  let shown = 0;
  for (const line of oldLines) {
    if (shown >= cap) break;
    rows.push(diffRow(`d${key++}`, '- ', line, theme.status.error, innerWidth, prefixLen));
    shown += 1;
  }
  for (const line of newLines) {
    if (shown >= cap) break;
    rows.push(diffRow(`d${key++}`, '+ ', line, theme.status.success, innerWidth, prefixLen));
    shown += 1;
  }
  if (total > cap) {
    rows.push(moreLinesRow(`d${key++}`, total - cap, prefixLen, theme));
  }
  return rows;
}

function renderWriteBody(
  entry: ToolEntry,
  { width, prefixLen, theme }: ToolBodyProps,
): React.ReactElement[] {
  const args = entry.toolArgs as { content?: string } | undefined;
  if (!args || typeof args.content !== 'string') return [];
  const stripped = stripTrailingNewline(args.content);
  if (stripped.length === 0) return [noOutputRow('w-empty', prefixLen, theme)];
  const lines = stripped.split('\n');
  const cap = TOOL_BODY_LIMITS.writeContentLines;
  const visible = lines.slice(0, cap);
  const gutterWidth = String(visible.length).length + 1;
  const innerWidth = bodyInnerWidth(width, prefixLen, gutterWidth);

  const rows: React.ReactElement[] = [];
  let rowNum = 1;
  for (const line of visible) {
    const num = String(rowNum).padStart(gutterWidth - 1, ' ');
    rows.push(
      <Box key={`w-${num}`} paddingLeft={prefixLen}>
        <Text>
          <Text color={theme.text.muted}>{num} </Text>
          <Text color={theme.text.muted}>{clip(line, innerWidth)}</Text>
        </Text>
      </Box>,
    );
    rowNum += 1;
  }
  if (lines.length > cap) {
    rows.push(moreLinesRow(`w-more`, lines.length - cap, prefixLen, theme));
  }
  return rows;
}

function renderBashBody(
  entry: ToolEntry,
  { width, prefixLen, theme }: ToolBodyProps,
): React.ReactElement[] {
  const result = entry.toolResult as { stdout?: string; stderr?: string } | undefined;
  if (!result) return [];
  const stdout = stripTrailingNewline(result.stdout ?? '');
  const stderr = stripTrailingNewline(result.stderr ?? '');
  const innerWidth = bodyInnerWidth(width, prefixLen, 0);

  if (stdout.length === 0 && stderr.length === 0) {
    return [noOutputRow('b-empty', prefixLen, theme)];
  }

  const rows: React.ReactElement[] = [];
  if (stdout.length > 0) {
    const lines = stdout.split('\n');
    const cap = TOOL_BODY_LIMITS.bashStdoutLines;
    for (let i = 0; i < lines.length && i < cap; i += 1) {
      rows.push(
        <Box key={`bo${i}`} paddingLeft={prefixLen}>
          <Text color={theme.text.muted}>{clip(lines[i], innerWidth)}</Text>
        </Box>,
      );
    }
    if (lines.length > cap) {
      rows.push(moreLinesRow('bo-more', lines.length - cap, prefixLen, theme));
    }
  }
  if (stderr.length > 0) {
    const lines = stderr.split('\n');
    const cap = TOOL_BODY_LIMITS.bashStderrLines;
    for (let i = 0; i < lines.length && i < cap; i += 1) {
      rows.push(
        <Box key={`be${i}`} paddingLeft={prefixLen}>
          <Text color={theme.status.error}>{clip(lines[i], innerWidth)}</Text>
        </Box>,
      );
    }
    if (lines.length > cap) {
      rows.push(moreLinesRow('be-more', lines.length - cap, prefixLen, theme));
    }
  }
  return rows;
}

function diffRow(
  key: string,
  prefix: '+ ' | '- ',
  body: string,
  bodyColor: string,
  innerWidth: number,
  prefixLen: number,
): React.ReactElement {
  return (
    <Box key={key} paddingLeft={prefixLen}>
      <Text>
        <Text color={bodyColor}>{prefix}</Text>
        <Text color={bodyColor}>{clip(body, innerWidth)}</Text>
      </Text>
    </Box>
  );
}

function hunkRow(
  key: string,
  row: { kind: 'same' | 'del' | 'add'; lineNumber: number; content: string },
  gutterWidth: number,
  innerWidth: number,
  prefixLen: number,
  theme: Theme,
): React.ReactElement {
  const sigil = row.kind === 'same' ? ' ' : row.kind === 'del' ? '-' : '+';
  const fg =
    row.kind === 'same'
      ? theme.text.muted
      : row.kind === 'del'
        ? theme.status.error
        : theme.status.success;
  const bg =
    row.kind === 'del'
      ? theme.status.errorBg
      : row.kind === 'add'
        ? theme.status.successBg
        : undefined;
  const gutter = String(row.lineNumber).padStart(gutterWidth - 1, ' ');
  const clipped = clip(row.content, innerWidth);
  const padded = clipped.padEnd(innerWidth, ' ');
  return (
    <Box key={key} paddingLeft={prefixLen}>
      <Text wrap="truncate">
        <Text color={theme.text.muted}>{`${gutter} `}</Text>
        <Text color={fg} backgroundColor={bg}>{`${sigil} ${padded}`}</Text>
      </Text>
    </Box>
  );
}

function moreLinesRow(
  key: string,
  count: number,
  prefixLen: number,
  theme: Theme,
): React.ReactElement {
  const noun = count === 1 ? 'line' : 'lines';
  return (
    <Box key={key} paddingLeft={prefixLen}>
      <Text color={theme.text.muted}>
        …{count} more {noun}
      </Text>
    </Box>
  );
}

function noOutputRow(key: string, prefixLen: number, theme: Theme): React.ReactElement {
  return (
    <Box key={key} paddingLeft={prefixLen}>
      <Text color={theme.text.muted}>(no output)</Text>
    </Box>
  );
}

function stripTrailingNewline(s: string): string {
  return s.replace(/\n+$/, '');
}

function bodyInnerWidth(width: number, prefixLen: number, gutter: number): number {
  return Math.max(4, width - prefixLen - gutter);
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}
