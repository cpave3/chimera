import { Box, Text } from 'ink';
import React from 'react';
import { formatElapsed } from './activity';
import { renderMarkdown } from './markdown';
import type { ScrollbackEntry, SubagentEntry, ToolEntry } from './scrollback';
import { renderToolBody } from './ToolBody';
import type { Theme } from './theme/types';

/**
 * Hard-wrap `text` into one string per visual line. Splits on explicit `\n`
 * first, then breaks each segment at `width` characters. The first segment's
 * available width is reduced by `firstOffset` to leave room for a marker
 * like `› ` or `• `.
 */
export function wrapToLines(text: string, width: number, firstOffset: number): string[] {
  if (text.length === 0) return [''];
  const available = Math.max(1, width);
  const segments = text.split('\n');
  const out: string[] = [];
  segments.forEach((seg, segIdx) => {
    let remaining = seg;
    let budget = available - (segIdx === 0 ? firstOffset : 0);
    if (budget < 1) budget = 1;
    if (remaining.length === 0) {
      out.push('');
      return;
    }
    while (remaining.length > budget) {
      out.push(remaining.slice(0, budget));
      remaining = remaining.slice(budget);
      budget = available;
    }
    out.push(remaining);
  });
  return out;
}

/**
 * Cap of nested subagent child rows rendered while the parent spawn_agent
 * tool entry is still in flight. The whole group lives in Ink's dynamic
 * region until the parent's tool_call_result lands, and a chatty subagent
 * (30-100 events/sec) would otherwise grow that region past the terminal
 * height — tipping Ink into its clearTerminal-per-frame fallback, which
 * flickers and erases the terminal's scrollback buffer (`\x1b[3J`) so the
 * user cannot scroll up. The full child list still commits to <Static>
 * atomically with the parent.
 */
const MAX_INFLIGHT_SUBAGENT_ROWS = 4;

export function clampInFlightChildren(
  parentId: string,
  children: SubagentEntry[],
): SubagentEntry[] {
  if (children.length <= MAX_INFLIGHT_SUBAGENT_ROWS) return children;
  const visible = children.slice(-(MAX_INFLIGHT_SUBAGENT_ROWS - 1));
  const elided = children.length - visible.length;
  return [
    {
      id: `${parentId}:elided`,
      kind: 'subagent',
      text: `… ${elided} earlier steps`,
      parentEntryId: parentId,
    },
    ...visible,
  ];
}

export interface RenderEntryOptions {
  /**
   * True when tool calls can run in two places. Only then does a tool line
   * say which one; without a sandbox every call runs on the host.
   */
  sandboxActive?: boolean;
}

const USER_MARKER = '› ';
const ASSISTANT_MARKER = '◆ ';
const TURN_RULE = '─── ';

type ToolState = 'running' | 'done' | 'failed';

// The glyph alone tells the state, so it still reads without colour.
const TOOL_STATE_GLYPH: Record<ToolState, string> = {
  running: '○ ',
  done: '● ',
  failed: '✗ ',
};
const TOOL_MARKER_WIDTH = TOOL_STATE_GLYPH.done.length;
const TOOL_STATE_COLOR: Record<ToolState, (theme: Theme) => string> = {
  running: (theme) => theme.status.warning,
  done: (theme) => theme.status.success,
  failed: (theme) => theme.status.error,
};

/** Tools whose body is a change to a file, drawn as a bordered block. */
const FILE_CHANGE_TOOLS = new Set(['edit', 'apply_patch', 'write']);
// Two border columns and one column of padding on each side.
const BODY_FRAME_WIDTH = 4;

function isToolLine(entry: ScrollbackEntry): boolean {
  return entry.kind === 'tool' || entry.kind === 'explore';
}

/**
 * Blank lines a layout leaves above `entry`. Tool lines that follow each
 * other read as one block of work, so nothing separates them.
 */
export function entryGap(previous: ScrollbackEntry | undefined, entry: ScrollbackEntry): number {
  return previous && isToolLine(previous) && isToolLine(entry) ? 0 : 1;
}

/** A command that ran but exited non-zero failed as far as the reader cares. */
function toolState(entry: ToolEntry): ToolState {
  if (entry.toolError !== undefined) return 'failed';
  if (entry.toolResult === undefined) return 'running';
  const exitCode = (entry.toolResult as { exit_code?: unknown } | null)?.exit_code;
  return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'done';
}

/** Tenths of a second below a minute, where they still matter; whole units above. */
function formatDuration(milliseconds: number): string {
  return milliseconds < 60_000
    ? `${(milliseconds / 1000).toFixed(1)}s`
    : formatElapsed(milliseconds);
}

export function renderEntryLines(
  entry: ScrollbackEntry,
  columns: number,
  theme: Theme,
  children: SubagentEntry[] = [],
  options: RenderEntryOptions = {},
): React.ReactElement[] {
  const width = Math.max(10, columns);

  if (entry.kind === 'user') {
    const imageLabels =
      entry.imageCount && entry.imageCount > 0
        ? Array.from({ length: entry.imageCount }, (_, i) => `[Image #${i + 1}]`).join(' ')
        : '';
    const displayText = imageLabels ? `${entry.text} ${imageLabels}` : entry.text;
    const lines = wrapToLines(displayText, width, USER_MARKER.length);
    return [
      <Box key={`${entry.id}:u`} flexDirection="column">
        <Text bold>
          <Text color={theme.ui.accent}>{USER_MARKER}</Text>
          {lines[0] ?? ''}
        </Text>
        {lines.slice(1).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
          <Box key={i} paddingLeft={USER_MARKER.length}>
            <Text bold>{line}</Text>
          </Box>
        ))}
      </Box>,
    ];
  }
  if (entry.kind === 'assistant') {
    return [
      <Box key={`${entry.id}:a`}>
        <Text color={theme.ui.accent}>{ASSISTANT_MARKER}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {renderMarkdown(entry.text, theme, Math.max(10, width - ASSISTANT_MARKER.length))}
        </Box>
      </Box>,
    ];
  }
  if (entry.kind === 'thinking') {
    const lines = entry.text.split('\n');
    return [
      <Box key={`${entry.id}:th`} flexDirection="column" paddingLeft={2}>
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for split output
          <Text key={i} color={theme.text.muted}>
            {line}
          </Text>
        ))}
      </Box>,
    ];
  }
  if (entry.kind === 'tool') {
    const badge = options.sandboxActive
      ? `${entry.toolTarget === 'host' ? '[host]' : '[sandbox]'} `
      : '';
    const namePrefix = entry.displayName ?? entry.toolName;
    const title = namePrefix ? `${namePrefix} ` : '';
    const prefixLen = TOOL_MARKER_WIDTH;
    const state = toolState(entry);
    const changesFile = FILE_CHANGE_TOOLS.has(entry.toolName ?? '');
    // A change to a file is what the reader came for; lookups stay quiet.
    const lineColor = changesFile ? theme.text.primary : theme.text.muted;
    const body = renderToolBody(
      entry,
      changesFile
        ? { width: width - prefixLen - BODY_FRAME_WIDTH, prefixLen: 0, theme }
        : { width, prefixLen, theme },
    );
    const duration =
      entry.durationMs !== undefined && entry.durationMs >= 1000
        ? ` · ${formatDuration(entry.durationMs)}`
        : '';
    const textLines = wrapToLines(`${badge}${title}${entry.text}${duration}`, width, prefixLen);
    const out: React.ReactElement[] = [
      <Box key={`${entry.id}:t`} flexDirection="column">
        <Text>
          <Text color={TOOL_STATE_COLOR[state](theme)}>{TOOL_STATE_GLYPH[state]}</Text>
          <Text color={lineColor}>{textLines[0] ?? ''}</Text>
        </Text>
        {textLines.slice(1).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
          <Box key={i} paddingLeft={prefixLen}>
            <Text color={lineColor}>{line}</Text>
          </Box>
        ))}
        {entry.detail !== undefined &&
          wrapToLines(entry.detail, width, prefixLen).map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
            <Box key={`d${i}`} paddingLeft={prefixLen}>
              <Text color={theme.text.muted}>{line}</Text>
            </Box>
          ))}
        {changesFile && body.length > 0 ? (
          <Box
            flexDirection="column"
            marginLeft={prefixLen}
            width={width - prefixLen}
            borderStyle="round"
            borderColor={theme.surface.border ?? theme.text.muted}
            paddingX={1}
          >
            {body}
          </Box>
        ) : (
          body
        )}
        {entry.skillName && (
          <Box paddingLeft={prefixLen}>
            <Text color={theme.ui.accent}>📚 skill: {entry.skillName}</Text>
          </Box>
        )}
        {children.map((child, idx) => {
          const isLast = idx === children.length - 1;
          const connector = isLast ? '└ ' : '├ ';
          const childLines = wrapToLines(child.text, width, prefixLen + connector.length);
          return (
            <Box key={`${entry.id}:c:${child.id}`} flexDirection="column" paddingLeft={prefixLen}>
              <Text>
                <Text color={theme.text.muted}>{connector}</Text>
                <Text color={theme.text.muted}>{childLines[0] ?? ''}</Text>
              </Text>
              {childLines.slice(1).map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
                <Box key={i} paddingLeft={connector.length}>
                  <Text color={theme.text.muted}>{line}</Text>
                </Box>
              ))}
              {child.detail !== undefined &&
                wrapToLines(child.detail, width, prefixLen + connector.length).map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
                  <Box key={`cd${i}`} paddingLeft={connector.length}>
                    <Text color={theme.text.muted}>{line}</Text>
                  </Box>
                ))}
            </Box>
          );
        })}
      </Box>,
    ];
    if (entry.toolError) {
      const errLines = wrapToLines(`error: ${entry.toolError}`, width, prefixLen);
      out.push(
        <Box key={`${entry.id}:e`} flexDirection="column" paddingLeft={prefixLen}>
          {errLines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
            <Text key={i} color={theme.status.error}>
              {line}
            </Text>
          ))}
        </Box>,
      );
    }
    return out;
  }
  if (entry.kind === 'explore') {
    // A group of one says more as the plain tool line it would have been.
    if (entry.members.length === 1) {
      return renderEntryLines({ ...entry.members[0]!, id: entry.id }, columns, theme, [], options);
    }
    const prefixLen = TOOL_MARKER_WIDTH;
    const names = entry.members.map((member) => member.text).join(', ');
    const room = Math.max(1, width - prefixLen);
    return [
      <Box key={`${entry.id}:x`} flexDirection="column">
        <Text>
          <Text color={TOOL_STATE_COLOR[entry.closed ? 'done' : 'running'](theme)}>
            {TOOL_STATE_GLYPH[entry.closed ? 'done' : 'running']}
          </Text>
          <Text color={theme.text.muted}>{entry.text}</Text>
        </Text>
        <Box paddingLeft={prefixLen}>
          <Text color={theme.text.dim ?? theme.text.muted}>
            {names.length > room ? `${names.slice(0, room - 1)}…` : names}
          </Text>
        </Box>
      </Box>,
    ];
  }
  if (entry.kind === 'subagent') {
    const idShort = entry.subagentId ? entry.subagentId.slice(-4) : '?';
    const labelParts = [`[subagent ${idShort}`];
    if (entry.subagentPurpose) labelParts.push(`: ${entry.subagentPurpose}`);
    labelParts.push(']');
    const label = labelParts.join('');
    const prefix = `${label} `;
    const lines = wrapToLines(entry.text, width, prefix.length + 2);
    return [
      <Box key={`${entry.id}:s`} flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={theme.ui.accent}>{label}</Text>{' '}
          <Text color={theme.text.muted}>{lines[0] ?? ''}</Text>
        </Text>
        {lines.slice(1).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
          <Box key={i} paddingLeft={prefix.length}>
            <Text color={theme.text.muted}>{line}</Text>
          </Box>
        ))}
      </Box>,
    ];
  }
  if (entry.kind === 'turn') {
    return [
      <Text key={`${entry.id}:turn`} color={theme.text.muted} wrap="truncate">
        {`${TURN_RULE}${entry.text}`}
      </Text>,
    ];
  }
  if (entry.kind === 'info' || entry.kind === 'mode_change') {
    const lines = wrapToLines(entry.text, width, 0);
    return lines.map((line, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
      <Text key={`${entry.id}:${i}`} color={theme.text.muted}>
        {line}
      </Text>
    ));
  }
  const lines = wrapToLines(entry.text, width, 0);
  return lines.map((line, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
    <Text key={`${entry.id}:${i}`} color={theme.status.error}>
      {line}
    </Text>
  ));
}
