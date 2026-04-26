import { Box, Text } from 'ink';
import React from 'react';
import type { ScrollbackEntry } from './scrollback';
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

function renderEditBody(
  entry: ScrollbackEntry,
  { width, prefixLen, theme }: ToolBodyProps,
): React.ReactElement[] {
  const args = entry.toolArgs as { old_string?: string; new_string?: string } | undefined;
  if (!args) return [];
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
  entry: ScrollbackEntry,
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

  const rows: React.ReactElement[] = visible.map((line, i) => {
    const num = String(i + 1).padStart(gutterWidth - 1, ' ');
    return (
      <Box key={`w${i}`} paddingLeft={prefixLen}>
        <Text>
          <Text color={theme.text.muted}>{num} </Text>
          <Text color={theme.text.muted}>{clip(line, innerWidth)}</Text>
        </Text>
      </Box>
    );
  });
  if (lines.length > cap) {
    rows.push(moreLinesRow(`w-more`, lines.length - cap, prefixLen, theme));
  }
  return rows;
}

function renderBashBody(
  entry: ScrollbackEntry,
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
    lines.slice(0, cap).forEach((line, i) => {
      rows.push(
        <Box key={`bo${i}`} paddingLeft={prefixLen}>
          <Text color={theme.text.muted}>{clip(line, innerWidth)}</Text>
        </Box>,
      );
    });
    if (lines.length > cap) {
      rows.push(moreLinesRow('bo-more', lines.length - cap, prefixLen, theme));
    }
  }
  if (stderr.length > 0) {
    const lines = stderr.split('\n');
    const cap = TOOL_BODY_LIMITS.bashStderrLines;
    lines.slice(0, cap).forEach((line, i) => {
      rows.push(
        <Box key={`be${i}`} paddingLeft={prefixLen}>
          <Text color={theme.status.error}>{clip(line, innerWidth)}</Text>
        </Box>,
      );
    });
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
