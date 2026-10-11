import { Box, Text } from 'ink';
import React from 'react';
import { previewLine } from './prompt-view';
import { useTheme } from './theme/ThemeProvider';

export interface QueueListProps {
  /** Messages held for the next turn, oldest first. */
  messages: string[];
  /** Rows the list may use. */
  maxLines: number;
}

/** The messages waiting for the run to end, so they are not out of sight. */
export function QueueList({ messages, maxLines }: QueueListProps): React.ReactElement | null {
  const theme = useTheme();
  if (messages.length === 0 || maxLines < 1) return null;
  const shown = messages.slice(0, maxLines);
  const hidden = messages.length - shown.length;
  return (
    <Box flexDirection="column">
      {shown.map((message, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: queued messages have no id; position is their identity
        <Text key={index} color={theme.text.muted} wrap="truncate">
          {`queued ${index + 1} · ${previewLine(message)}${
            index === shown.length - 1 && hidden > 0 ? `  (+${hidden} more)` : ''
          }`}
        </Text>
      ))}
    </Box>
  );
}
