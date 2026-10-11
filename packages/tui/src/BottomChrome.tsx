import type { SandboxMode } from '@chimera/core';
import type { ModeRegistry } from '@chimera/modes';
import { Box, Text } from 'ink';
import React, { memo } from 'react';
import { displayPath } from './display-path';
import { StatusBar } from './StatusBar';
import type { UsageState } from './session-events';
import { useTheme } from './theme/ThemeProvider';
import { formatTokens, pickUsageColor } from './usage-format';

export interface BottomChromeProps {
  /** Terminal width; the rows drop their least important items to fit it. */
  width: number;
  cwd: string;
  sessionId: string;
  sandboxMode: SandboxMode;
  modes?: ModeRegistry;
  activeModeName: string;
  /** A mode switch queued for the next run, shown as `active → pending`. */
  pendingModeName: string | null;
  currentModelRef: string;
  /** Model the current turn is routed to because it carries images. */
  visionRouteRef: string | null;
  forked: boolean;
  running: boolean;
  tasks: { content: string; status: string }[];
  usageState: UsageState | null;
}

/** One item of a footer row: what to draw, how wide it is, and how readily it gives way. */
interface Item {
  key: string;
  node: React.ReactNode;
  width: number;
  /** Items with a lower rank are dropped first when the row does not fit. */
  rank: number;
}

const SEPARATOR_WIDTH = 3;
const GAUGE_CELLS = 10;
const MAX_TASK_NAME = 40;
const MAX_CWD = 48;

function rowWidth(items: Item[]): number {
  return (
    items.reduce((sum, item) => sum + item.width, 0) +
    Math.max(0, items.length - 1) * SEPARATOR_WIDTH
  );
}

/** Drop the lowest-ranked items until the two groups fit side by side. */
function fitRow(width: number, left: Item[], right: Item[]): { left: Item[]; right: Item[] } {
  let keptLeft = left;
  let keptRight = right;
  while (rowWidth(keptLeft) + rowWidth(keptRight) + (keptRight.length > 0 ? 2 : 0) > width) {
    const candidates = [...keptLeft, ...keptRight];
    if (candidates.length <= 1) break;
    const victim = candidates.reduce((lowest, item) => (item.rank < lowest.rank ? item : lowest));
    keptLeft = keptLeft.filter((item) => item !== victim);
    keptRight = keptRight.filter((item) => item !== victim);
  }
  return { left: keptLeft, right: keptRight };
}

function clipEnd(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The two rows under the prompt. The first says what is running and how much
 * room is left; the second says where, on what task, and which keys matter
 * right now. Memoized so prompt and transcript re-renders do not rebuild it.
 */
export const BottomChrome = memo(function BottomChrome({
  width,
  cwd,
  sessionId,
  sandboxMode,
  modes,
  activeModeName,
  pendingModeName,
  currentModelRef,
  visionRouteRef,
  forked,
  running,
  tasks,
  usageState,
}: BottomChromeProps): React.ReactElement {
  const theme = useTheme();
  const muted = theme.text.muted;
  const text = (key: string, value: string, color: string, rank: number): Item => ({
    key,
    node: (
      <Text key={key} color={color}>
        {value}
      </Text>
    ),
    width: value.length,
    rank,
  });

  // Row 1, left: what is running.
  const pendingName = pendingModeName && pendingModeName !== activeModeName ? pendingModeName : '';
  const modeLabel = pendingName ? `${activeModeName} → ${pendingName}` : activeModeName;
  const model = `${currentModelRef}${visionRouteRef ? ` → ${visionRouteRef} (vision)` : ''}`;
  const stateLeft: Item[] = [
    {
      key: 'mode',
      width: modeLabel.length,
      rank: 100,
      node: (
        <Text key="mode">
          <Text color={modes?.find(activeModeName)?.colorHex ?? theme.accent.secondary}>
            {activeModeName}
          </Text>
          {pendingName && (
            <>
              <Text color={muted}>{' → '}</Text>
              <Text color={modes?.find(pendingName)?.colorHex ?? theme.accent.secondary}>
                {pendingName}
              </Text>
            </>
          )}
        </Text>
      ),
    },
    text('model', model, theme.accent.primary, 90),
    text('sandbox', `sandbox ${sandboxMode}`, muted, 40),
    ...(forked ? [text('forked', 'forked', theme.accent.secondary, 30)] : []),
  ];

  // Row 1, right: how much room is left.
  const stateRight: Item[] = [];
  let plainPercent: Item | undefined;
  if (usageState) {
    const { contextWindow, usedContextTokens, unknownWindow, usage } = usageState;
    const share = contextWindow > 0 ? usedContextTokens / contextWindow : null;
    const percent = share === null ? null : Math.round(share * 100);
    const level = pickUsageColor(percent, theme);
    if (share !== null) {
      const filled = Math.min(GAUGE_CELLS, Math.round(share * GAUGE_CELLS));
      const label = `${percent}%`;
      plainPercent = text('percent', label, level, 80);
      // The gauge and its figure read as one item; without room for the
      // gauge the figure stands alone.
      stateRight.push({
        key: 'percent',
        width: GAUGE_CELLS + 1 + label.length,
        rank: 80,
        node: (
          <Text key="percent">
            <Text color={level}>{'▰'.repeat(filled)}</Text>
            <Text color={muted}>{'▱'.repeat(GAUGE_CELLS - filled)}</Text>
            <Text color={level}>{` ${label}`}</Text>
          </Text>
        ),
      });
    }
    const counts =
      share === null
        ? `${formatTokens(usedContextTokens)} tokens`
        : `${formatTokens(usedContextTokens)}/${formatTokens(contextWindow)}${unknownWindow ? '?' : ''}`;
    stateRight.push(text('tokens', counts, muted, share === null ? 80 : 50));
    const lastStep = usage.lastStep;
    if (lastStep && lastStep.inputTokens > 0 && lastStep.cachedInputTokens > 0) {
      const cached = Math.min(
        100,
        Math.round((lastStep.cachedInputTokens / lastStep.inputTokens) * 100),
      );
      stateRight.push(text('cache', `cache ${cached}%`, muted, 20));
    }
  }

  // Row 2, left: where, and on what.
  const placeLeft: Item[] = [
    text('cwd', displayPath(cwd, MAX_CWD), theme.accent.primary, 60),
    text('session', `session ${sessionId.slice(-8)}`, muted, 70),
  ];
  if (tasks.length > 0) {
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const allDone = completed === tasks.length;
    placeLeft.push(
      text(
        'tasks',
        `tasks ${completed}/${tasks.length}${allDone ? ' ✔' : ''}`,
        theme.accent.secondary,
        50,
      ),
    );
    const current = tasks.find((task) => task.status === 'in_progress');
    if (current) {
      placeLeft.push(text('task', `◼ ${clipEnd(current.content, MAX_TASK_NAME)}`, muted, 25));
    }
  }

  // Row 2, right: the keys that matter in this state.
  const hints = running
    ? ['enter steer', 'esc interrupt', 'ctrl+t transcript']
    : ['? help', '/ commands', 'shift+tab mode', 'ctrl+t transcript'];
  const placeRight: Item[] = hints.map((hint, index) =>
    text(`hint${index}`, hint, muted, index < 2 ? 15 - index : 5 - index),
  );

  const everythingFits = rowWidth(stateLeft) + rowWidth(stateRight) + 2 <= width;
  const state = fitRow(
    width,
    stateLeft,
    everythingFits || !plainPercent
      ? stateRight
      : stateRight.map((item) => (item.key === 'percent' ? plainPercent! : item)),
  );
  const place = fitRow(width, placeLeft, placeRight);
  return (
    <Box flexDirection="column" width={width}>
      <StatusBar
        left={state.left.map((item) => item.node)}
        right={state.right.map((item) => item.node)}
        separatorColor={muted}
      />
      <StatusBar
        left={place.left.map((item) => item.node)}
        right={place.right.map((item) => item.node)}
        separatorColor={muted}
      />
    </Box>
  );
});
