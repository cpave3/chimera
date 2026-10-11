import type { SandboxMode, Usage } from '@chimera/core';
import type { ModeRegistry } from '@chimera/modes';
import { Text } from 'ink';
import React, { memo, useMemo } from 'react';
import { ChromeBar } from './ChromeBar';
import type { StatusBarWidget } from './StatusBar';
import { useTheme } from './theme/ThemeProvider';
import { UsageWidget } from './UsageWidget';

export interface BottomChromeProps {
  cwd: string;
  sandboxMode: SandboxMode;
  modes?: ModeRegistry;
  activeModeName: string;
  /** A mode switch queued for the next run, shown as `active → pending`. */
  pendingModeName: string | null;
  currentModelRef: string;
  /** Model the current turn is routed to because it carries images. */
  visionRouteRef: string | null;
  sessionId: string;
  forked: boolean;
  tasks: { content: string; status: string }[];
  usageState: {
    usage: Usage;
    contextWindow: number;
    usedContextTokens: number;
    unknownWindow: boolean;
  } | null;
}

/**
 * The status rows under the prompt. Owns the widget construction so that the
 * prompt and transcript re-rendering many times per second do not rebuild it.
 */
export const BottomChrome = memo(function BottomChrome({
  cwd,
  sandboxMode,
  modes,
  activeModeName,
  pendingModeName,
  currentModelRef,
  visionRouteRef,
  sessionId,
  forked,
  tasks,
  usageState,
}: BottomChromeProps): React.ReactElement {
  const theme = useTheme();
  const cwdLeft = useMemo<StatusBarWidget[]>(
    () => [
      <Text key="cwd" color={theme.accent.primary}>
        {cwd}
      </Text>,
    ],
    [cwd, theme.accent.primary],
  );
  const cwdRight = useMemo<StatusBarWidget[]>(
    () => [
      <Text key="sandbox" color={theme.text.muted}>
        {`[sandbox:${sandboxMode}]`}
      </Text>,
    ],
    [sandboxMode, theme.text.muted],
  );
  const activeModeObj = modes?.find(activeModeName);
  const pendingModeObj = pendingModeName ? modes?.find(pendingModeName) : undefined;
  const modeWidget = useMemo<StatusBarWidget>(() => {
    if (pendingModeObj && pendingModeObj.name !== activeModeName) {
      return (
        <Text>
          <Text color={theme.text.muted}>[mode:</Text>
          <Text color={activeModeObj?.colorHex ?? theme.text.muted}>{activeModeName}</Text>
          <Text color={theme.text.muted}>{' → '}</Text>
          <Text color={pendingModeObj.colorHex}>{pendingModeObj.name}</Text>
          <Text color={theme.text.muted}>]</Text>
        </Text>
      );
    }
    return (
      <Text>
        <Text color={theme.text.muted}>[mode:</Text>
        <Text color={activeModeObj?.colorHex ?? theme.text.muted}>{activeModeName}</Text>
        <Text color={theme.text.muted}>]</Text>
      </Text>
    );
  }, [activeModeName, activeModeObj, pendingModeName, pendingModeObj, theme.text.muted]);
  const modelLeft = useMemo<StatusBarWidget[]>(
    () => [
      modeWidget,
      <Text key="model" color={theme.accent.primary}>
        {`${currentModelRef}${visionRouteRef ? ` → ${visionRouteRef} (vision)` : ''}`}
      </Text>,
      <Text key="session" color={theme.text.muted}>
        {`session ${sessionId.slice(-8)}`}
      </Text>,
      forked ? (
        <Text key="forked" color={theme.accent.secondary}>
          (forked)
        </Text>
      ) : null,
    ],
    [
      modeWidget,
      currentModelRef,
      visionRouteRef,
      sessionId,
      forked,
      theme.accent.primary,
      theme.text.muted,
      theme.accent.secondary,
    ],
  );
  const tasksWidget = useMemo<StatusBarWidget>(() => {
    if (tasks.length === 0) return null;
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const active = tasks.find((task) => task.status === 'in_progress');
    const label = active
      ? `[tasks ${completed}/${tasks.length}: ${active.content.length > 40 ? `${active.content.slice(0, 40)}…` : active.content}]`
      : `[tasks ${completed}/${tasks.length}${completed === tasks.length ? ' done' : ''}]`;
    return (
      <Text key="tasks" color={theme.accent.secondary}>
        {label}
      </Text>
    );
  }, [tasks, theme.accent.secondary]);
  const modelRight = useMemo<StatusBarWidget[]>(
    () => [
      tasksWidget,
      usageState && (
        <UsageWidget
          key="usage"
          usage={usageState.usage}
          contextWindow={usageState.contextWindow}
          usedContextTokens={usageState.usedContextTokens}
          unknownWindow={usageState.unknownWindow}
        />
      ),
    ],
    [tasksWidget, usageState],
  );

  return (
    <ChromeBar
      cwdLeft={cwdLeft}
      cwdRight={cwdRight}
      modelLeft={modelLeft}
      modelRight={modelRight}
      separatorColor={theme.text.muted}
      mutedColor={theme.text.muted}
    />
  );
});
