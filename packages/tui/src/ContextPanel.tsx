import type { SessionStatus } from '@chimera/core';
import { Box, Text } from 'ink';
import React, { memo } from 'react';
import { contextBar } from './context-bar';
import { displayPath } from './display-path';
import type { UsageState } from './session-events';
import { useTheme } from './theme/ThemeProvider';
import type { Theme } from './theme/types';
import { formatTokens, pickUsageColor } from './usage-format';
import { CHIMERA_VERSION } from './version';
import type { SandboxLabel } from './view';
import type { WorktreeFile, WorktreeStatus } from './worktree';

/** Another live Chimera instance on this machine. */
export interface Peer {
  /** What tells this instance from the others: its directory, or its session. */
  label: string;
  mode?: string;
  /** Absent when the instance did not answer. */
  status?: SessionStatus;
}

export interface ContextPanelProps {
  /** Columns the panel takes, border and padding included. */
  width: number;
  modelRef: string;
  /** Model the turn in progress is routed to because it carries images. */
  visionRouteRef: string | null;
  sessionId: string;
  forked: boolean;
  cwd: string;
  sandboxMode: SandboxLabel;
  skillCount: number;
  commandCount: number;
  usageState: UsageState | null;
  /** Estimated tokens of the system prompt, skills index included; null when not known. */
  systemTokens: number | null;
  skillsTokens: number;
  tasks: { content: string; status: string }[];
  worktree: WorktreeStatus | null;
  peers: Peer[];
}

const BORDER_COLUMNS = 1;
const PADDING_COLUMNS = 2;
const MAX_PLAN_LINES = 8;
const MAX_WORKTREE_FILES = 8;
const MAX_PEERS = 5;
const HALF_GAP_COLUMNS = 2;
// A completed task above the current one keeps the reader's place in the plan.
const PLAN_LEAD_IN = 1;

function clipEnd(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function clipStart(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - Math.max(0, max - 1))}` : text;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function Heading({ children, theme }: { children: string; theme: Theme }): React.ReactElement {
  return <Text color={theme.text.muted}>{children}</Text>;
}

function Fact({
  label,
  value,
  color,
  width,
  theme,
}: {
  label: string;
  value: string;
  color: string;
  width: number;
  theme: Theme;
}): React.ReactElement {
  const room = Math.max(1, width - label.length - 2);
  return (
    <Box width={width} justifyContent="space-between">
      <Text color={theme.text.muted}>{label}</Text>
      <Text color={color}>{clipStart(value, room)}</Text>
    </Box>
  );
}

const STATUS_COLOR: Record<WorktreeFile['status'], (theme: Theme) => string> = {
  M: (theme) => theme.status.warning,
  A: (theme) => theme.status.success,
  D: (theme) => theme.status.error,
  R: (theme) => theme.accent.secondary,
  U: (theme) => theme.status.error,
};

/** The shortest tail of each path that no other changed file shares. */
function shortNames(files: WorktreeFile[]): string[] {
  return files.map((file) => {
    // Git names an untracked directory with a slash at its end.
    const directory = file.path.endsWith('/');
    const segments = (directory ? file.path.slice(0, -1) : file.path).split('/');
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const tail = `${segments.slice(-depth).join('/')}${directory ? '/' : ''}`;
      const shared = files.some((other) => other !== file && other.path.endsWith(`/${tail}`));
      if (!shared) return tail;
    }
    return file.path;
  });
}

function peerState(status: SessionStatus | undefined): string {
  // One word each: the row also holds the peer's name and its mode.
  if (status === 'running') return 'working';
  if (status === 'waiting_for_permission') return 'approval';
  if (status === 'waiting_for_input') return 'input';
  return status ?? '';
}

function peerColor(status: SessionStatus | undefined, theme: Theme): string {
  if (status === 'idle') return theme.status.success;
  if (status === 'running') return theme.status.warning;
  if (status === undefined) return theme.text.dim ?? theme.text.muted;
  return theme.status.error;
}

/**
 * The right column of the fullscreen layout: what the session runs on, how
 * full its context is, the plan, the working tree and the other instances.
 * Memoized so transcript and prompt re-renders do not rebuild it.
 */
export const ContextPanel = memo(function ContextPanel(
  props: ContextPanelProps,
): React.ReactElement {
  const theme = useTheme();
  const { usageState, tasks, worktree, peers } = props;
  const inner = Math.max(8, props.width - BORDER_COLUMNS - 2 * PADDING_COLUMNS);
  const dim = theme.text.dim ?? theme.text.muted;
  const sections: React.ReactElement[] = [];

  const loaded = [
    ...(props.skillCount > 0 ? [count(props.skillCount, 'skill')] : []),
    ...(props.commandCount > 0 ? [count(props.commandCount, 'cmd')] : []),
  ];
  sections.push(
    <Box key="session" flexDirection="column" flexShrink={0}>
      <Text>
        <Text color={theme.ui.accent} bold>
          ◆ chimera
        </Text>
        <Text color={dim}>{` v${CHIMERA_VERSION}`}</Text>
      </Text>
      <Fact
        label="model"
        value={props.modelRef}
        color={theme.accent.tertiary ?? theme.accent.primary}
        width={inner}
        theme={theme}
      />
      {props.visionRouteRef && (
        <Fact
          label="vision"
          value={props.visionRouteRef}
          color={theme.accent.tertiary ?? theme.accent.primary}
          width={inner}
          theme={theme}
        />
      )}
      <Fact
        label="session"
        value={`${props.sessionId.slice(-8)}${props.forked ? ' (fork)' : ''}`}
        color={theme.text.primary}
        width={inner}
        theme={theme}
      />
      <Fact
        label="cwd"
        value={displayPath(props.cwd, inner - 5)}
        color={theme.text.primary}
        width={inner}
        theme={theme}
      />
      <Fact
        label="sandbox"
        value={props.sandboxMode}
        color={props.sandboxMode === 'off' ? theme.ui.badge : theme.status.success}
        width={inner}
        theme={theme}
      />
      {loaded.length > 0 && (
        <Fact
          label="loaded"
          value={loaded.join(' · ')}
          color={theme.text.primary}
          width={inner}
          theme={theme}
        />
      )}
    </Box>,
  );

  if (usageState) {
    const { usedContextTokens: used, contextWindow: window, unknownWindow } = usageState;
    const known = window > 0;
    const percent = known ? Math.round((used / window) * 100) : null;
    const cells = contextBar({
      used,
      window,
      systemTokens: props.systemTokens ?? 0,
      skillsTokens: props.systemTokens === null ? 0 : props.skillsTokens,
      cells: inner,
    });
    const filledGlyph = '▄';
    // Without a fill colour for the track, a lower glyph keeps it apart from the bar.
    const freeGlyph = theme.surface.sunken ? '▄' : '▁';
    const split = cells.system + cells.skills > 0;
    sections.push(
      <Box key="context" flexDirection="column" flexShrink={0}>
        <Box width={inner} justifyContent="space-between">
          <Text color={theme.text.muted}>
            {known
              ? `CONTEXT · ${formatTokens(used)} / ${formatTokens(window)}${unknownWindow ? '?' : ''}`
              : `CONTEXT · ${formatTokens(used)} tokens`}
          </Text>
          {percent !== null && <Text color={pickUsageColor(percent, theme)}>{`${percent}%`}</Text>}
        </Box>
        {known && (
          <Text>
            <Text color={dim}>{filledGlyph.repeat(cells.system)}</Text>
            <Text color={theme.accent.secondary}>{filledGlyph.repeat(cells.skills)}</Text>
            <Text color={theme.ui.accent}>{filledGlyph.repeat(cells.history)}</Text>
            <Text color={theme.surface.sunken ?? dim}>{freeGlyph.repeat(cells.free)}</Text>
          </Text>
        )}
        {known && split && (
          <Text color={theme.text.muted}>
            <Text color={dim}>■</Text>
            {' system '}
            <Text color={theme.accent.secondary}>■</Text>
            {' skills '}
            <Text color={theme.ui.accent}>■</Text>
            {' history'}
          </Text>
        )}
      </Box>,
    );
  }

  if (tasks.length > 0) {
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const current = tasks.findIndex((task) => task.status !== 'completed');
    const start =
      tasks.length <= MAX_PLAN_LINES
        ? 0
        : Math.max(
            0,
            Math.min((current < 0 ? 0 : current) - PLAN_LEAD_IN, tasks.length - MAX_PLAN_LINES),
          );
    const shown = tasks.slice(start, start + MAX_PLAN_LINES);
    const after = tasks.length - start - shown.length;
    sections.push(
      <Box key="plan" flexDirection="column" flexShrink={0}>
        <Heading theme={theme}>{`PLAN · ${completed}/${tasks.length}`}</Heading>
        {start > 0 && <Text color={dim}>{`… ${start} done`}</Text>}
        {shown.map((task, offset) => {
          const done = task.status === 'completed';
          const active = task.status === 'in_progress';
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: tasks have no id; position is their identity
            <Text key={start + offset} wrap="truncate">
              <Text color={done ? theme.status.success : active ? theme.ui.accent : dim}>
                {done ? '✓' : active ? '▸' : '○'}
              </Text>
              <Text color={active ? theme.text.primary : theme.text.muted}>
                {` ${clipEnd(task.content, inner - 2)}`}
              </Text>
            </Text>
          );
        })}
        {after > 0 && <Text color={dim}>{`… ${after} more`}</Text>}
      </Box>,
    );
  }

  if (worktree) {
    const drift = [
      ...(worktree.ahead > 0 ? [`↑${worktree.ahead}`] : []),
      ...(worktree.behind > 0 ? [`↓${worktree.behind}`] : []),
    ].join(' ');
    const files = worktree.files.slice(0, MAX_WORKTREE_FILES);
    const names = shortNames(files);
    const hidden = worktree.files.length - files.length;
    sections.push(
      <Box key="worktree" flexDirection="column" flexShrink={0}>
        <Heading theme={theme}>WORKTREE</Heading>
        <Box width={inner} justifyContent="space-between">
          <Text color={theme.text.primary}>
            {clipEnd(worktree.branch, inner - drift.length - 1)}
          </Text>
          <Text color={theme.text.muted}>
            {drift || (worktree.files.length === 0 ? 'clean' : '')}
          </Text>
        </Box>
        {files.map((file, index) => {
          const counted = file.added !== undefined && file.removed !== undefined;
          const added = counted ? `+${file.added}` : '';
          const removed = counted ? `−${file.removed}` : '';
          const countsWidth = counted ? added.length + removed.length + 2 : 0;
          return (
            <Box key={file.path} width={inner} justifyContent="space-between">
              <Text color={STATUS_COLOR[file.status](theme)}>
                {`${file.status} ${clipStart(names[index]!, inner - 2 - countsWidth)}`}
              </Text>
              {counted && (
                <Text>
                  <Text color={theme.status.success}>{added}</Text>
                  <Text color={theme.status.error}>{` ${removed}`}</Text>
                </Text>
              )}
            </Box>
          );
        })}
        {hidden > 0 && <Text color={dim}>{`… ${hidden} more`}</Text>}
      </Box>,
    );
  }

  if (peers.length > 0) {
    const shown = peers.slice(0, MAX_PEERS);
    sections.push(
      <Box key="peers" flexDirection="column" flexShrink={0}>
        <Heading theme={theme}>PEERS</Heading>
        {shown.map((peer, index) => {
          const state = [peer.mode, peerState(peer.status)].filter(Boolean).join(' · ');
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: two peers may share a label
            <Box key={index} width={inner} justifyContent="space-between">
              <Text>
                <Text color={peerColor(peer.status, theme)}>●</Text>
                <Text color={theme.text.primary}>
                  {` ${clipEnd(peer.label, inner - state.length - 3)}`}
                </Text>
              </Text>
              <Text color={theme.text.muted}>{state}</Text>
            </Box>
          );
        })}
        {peers.length > shown.length && (
          <Text color={dim}>{`… ${peers.length - shown.length} more`}</Text>
        )}
      </Box>,
    );
  }

  const usage = usageState?.usage;
  const lastStep = usage?.lastStep;
  // "in" and "out" share a row, half of the panel each.
  const halfWidth = Math.floor((inner - HALF_GAP_COLUMNS) / 2);
  const cached =
    lastStep && lastStep.inputTokens > 0 && lastStep.cachedInputTokens > 0
      ? Math.min(100, Math.round((lastStep.cachedInputTokens / lastStep.inputTokens) * 100))
      : null;

  return (
    <Box
      width={props.width}
      flexShrink={0}
      flexDirection="column"
      backgroundColor={theme.surface.panel}
      // The fill sets the panel apart; without one, a line does.
      {...(theme.surface.panel
        ? { paddingLeft: PADDING_COLUMNS + BORDER_COLUMNS }
        : {
            borderStyle: 'single' as const,
            borderTop: false,
            borderBottom: false,
            borderRight: false,
            borderColor: theme.surface.border ?? theme.text.muted,
            paddingLeft: PADDING_COLUMNS,
          })}
      paddingRight={PADDING_COLUMNS}
      paddingTop={1}
    >
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" gap={1}>
        {sections}
      </Box>
      {usage && (
        <Box flexDirection="column" flexShrink={0}>
          <Fact
            label="total"
            value={formatTokens(usage.totalTokens)}
            color={theme.text.primary}
            width={inner}
            theme={theme}
          />
          <Box width={inner} justifyContent="space-between">
            <Fact
              label="in"
              value={formatTokens(usage.inputTokens)}
              color={theme.text.primary}
              width={halfWidth}
              theme={theme}
            />
            <Fact
              label="out"
              value={formatTokens(usage.outputTokens)}
              color={theme.text.primary}
              width={inner - halfWidth - HALF_GAP_COLUMNS}
              theme={theme}
            />
          </Box>
          {cached !== null && (
            <Fact
              label="cache"
              value={`${cached}%`}
              color={theme.text.primary}
              width={inner}
              theme={theme}
            />
          )}
        </Box>
      )}
    </Box>
  );
});
