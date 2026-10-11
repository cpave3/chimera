import type { SandboxMode } from '@chimera/core';
import type { ModeRegistry } from '@chimera/modes';
import { Text } from 'ink';
import React, { memo } from 'react';
import { StatusBar, type StatusBarWidget } from './StatusBar';
import type { UsageState } from './session-events';
import { useTheme } from './theme/ThemeProvider';
import { UsageWidget } from './UsageWidget';

export interface BottomChromeProps {
  sandboxMode: SandboxMode;
  modes?: ModeRegistry;
  activeModeName: string;
  /** A mode switch queued for the next run, shown as `active → pending`. */
  pendingModeName: string | null;
  currentModelRef: string;
  /** Model the current turn is routed to because it carries images. */
  visionRouteRef: string | null;
  forked: boolean;
  tasks: { content: string; status: string }[];
  usageState: UsageState | null;
}

/**
 * The one status row under the prompt: what answers "where am I and how
 * much room is left" at a glance. Everything else (cwd, session id, key
 * bindings) is a keystroke or a command away and does not need a permanent
 * row. Memoized so prompt and transcript re-renders do not rebuild it.
 */
export const BottomChrome = memo(function BottomChrome({
  sandboxMode,
  modes,
  activeModeName,
  pendingModeName,
  currentModelRef,
  visionRouteRef,
  forked,
  tasks,
  usageState,
}: BottomChromeProps): React.ReactElement {
  const theme = useTheme();
  const activeMode = modes?.find(activeModeName);
  const pendingMode =
    pendingModeName && pendingModeName !== activeModeName
      ? { name: pendingModeName, colorHex: modes?.find(pendingModeName)?.colorHex }
      : undefined;
  const completedTasks = tasks.filter((task) => task.status === 'completed').length;

  const left: StatusBarWidget[] = [
    <Text key="mode">
      <Text color={activeMode?.colorHex ?? theme.accent.secondary}>{activeModeName}</Text>
      {pendingMode && (
        <>
          <Text color={theme.text.muted}>{' → '}</Text>
          <Text color={pendingMode.colorHex ?? theme.accent.secondary}>{pendingMode.name}</Text>
        </>
      )}
    </Text>,
    <Text key="model" color={theme.accent.primary}>
      {`${currentModelRef}${visionRouteRef ? ` → ${visionRouteRef} (vision)` : ''}`}
    </Text>,
    usageState && (
      <UsageWidget
        key="usage"
        usage={usageState.usage}
        contextWindow={usageState.contextWindow}
        usedContextTokens={usageState.usedContextTokens}
        unknownWindow={usageState.unknownWindow}
      />
    ),
    sandboxMode !== 'off' && (
      <Text key="sandbox" color={theme.text.muted}>{`sandbox ${sandboxMode}`}</Text>
    ),
    forked && (
      <Text key="forked" color={theme.accent.secondary}>
        forked
      </Text>
    ),
  ];
  const right: StatusBarWidget[] = [
    tasks.length > 0 && (
      <Text key="tasks" color={theme.accent.secondary}>
        {`tasks ${completedTasks}/${tasks.length}`}
      </Text>
    ),
    <Text key="help" color={theme.text.muted}>
      ? help
    </Text>,
  ];

  return <StatusBar left={left} right={right} separatorColor={theme.text.muted} />;
});
