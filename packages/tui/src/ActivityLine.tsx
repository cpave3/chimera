import { Text } from 'ink';
import React from 'react';
import { formatElapsed } from './activity';
import { useTheme } from './theme/ThemeProvider';
import { formatTokens } from './usage-format';

export interface ActivityLineProps {
  spinner: string;
  /** What the run is doing, from `describeActivity`. */
  label: string;
  elapsedMs: number;
  /** The model step in progress, counted from 1; 0 leaves it out. */
  step: number;
  /** Output tokens produced since the run started. */
  tokens: number;
  /** False while only a compaction is in flight: there is no run to interrupt. */
  canInterrupt: boolean;
  width: number;
}

/** The single live line that says what the agent is doing and for how long. */
export function ActivityLine({
  spinner,
  label,
  elapsedMs,
  step,
  tokens,
  canInterrupt,
  width,
}: ActivityLineProps): React.ReactElement {
  const theme = useTheme();
  const facts = [
    formatElapsed(elapsedMs),
    ...(step > 0 ? [`step ${step}`] : []),
    ...(tokens > 0 ? [`${formatTokens(tokens)} tokens`] : []),
    ...(canInterrupt ? ['esc to interrupt'] : []),
  ];
  const suffix = ` · ${facts.join(' · ')}`;
  const room = Math.max(8, width - suffix.length - 2);
  const shown = label.length > room ? `${label.slice(0, room - 1)}…` : label;
  return (
    <Text wrap="truncate">
      <Text color={theme.ui.accent}>{`${spinner} ${shown}`}</Text>
      <Text color={theme.text.muted}>{suffix}</Text>
    </Text>
  );
}
