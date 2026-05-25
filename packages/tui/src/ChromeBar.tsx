import { Box } from 'ink';
import React, { memo } from 'react';
import { HintsBar } from './HintsBar';
import { StatusBar, type StatusBarWidget } from './StatusBar';

export interface ChromeBarProps {
  cwdLeft: StatusBarWidget[];
  cwdRight: StatusBarWidget[];
  modelLeft: StatusBarWidget[];
  modelRight: StatusBarWidget[];
  separatorColor: string;
  mutedColor: string;
}

/**
 * The entire bottom chrome rendered in its own memo boundary.
 * Separated from the prompt region so Ink doesn't redraw the chrome
 * when the prompt grows or shrinks.
 */
export const ChromeBar = memo(function ChromeBar({
  cwdLeft,
  cwdRight,
  modelLeft,
  modelRight,
  separatorColor,
  mutedColor,
}: ChromeBarProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <StatusBar left={cwdLeft} right={cwdRight} separatorColor={separatorColor} />
      <StatusBar left={modelLeft} right={modelRight} separatorColor={separatorColor} />
      <StatusBar
        left={[<HintsBar key="hints" mutedColor={mutedColor} />]}
        separatorColor={separatorColor}
      />
    </Box>
  );
});
