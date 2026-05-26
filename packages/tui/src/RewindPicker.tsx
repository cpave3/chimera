import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import type { Checkpoint } from '@chimera/core';
import { useTheme } from './theme/ThemeProvider';

export interface RewindPickerProps {
  checkpoints: Checkpoint[];
  onRewind(checkpoint: Checkpoint): void;
  onFork(checkpoint: Checkpoint): void;
  onCancel(): void;
}


export function RewindPicker(props: RewindPickerProps): React.ReactElement {
  const theme = useTheme();
  const [highlight, setHighlight] = useState(0);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      props.onCancel();
      return;
    }
    // Ink does not set key.shift for kitty SGR sequence (CSI 13;2u), so fall back to the stripped string.
    if ((key.shift && key.return) || input === '[13;2u') {
      props.onFork(props.checkpoints[highlight]!);
      return;
    }
    if (key.return) {
      props.onRewind(props.checkpoints[highlight]!);
      return;
    }
    if (key.upArrow || (input === 'k' && !key.ctrl && !key.meta)) {
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.downArrow || (input === 'j' && !key.ctrl && !key.meta)) {
      setHighlight((h) => Math.min(props.checkpoints.length - 1, h + 1));
      return;
    }
  });

  if (props.checkpoints.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text>No checkpoints. Press Esc to close.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Rewind to checkpoint</Text>
      <Text color={theme.text.muted}>Enter rewind · Shift+Enter fork · Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {props.checkpoints.map((cp, idx) => {
          const isHighlighted = idx === highlight;
          const summary = cp.toolCallSummary ? ` · ${cp.toolCallSummary}` : '';
          const text = `[${cp.index}] ${cp.userMessage}${summary}`;
          return (
            <Text key={cp.index} inverse={isHighlighted} color={isHighlighted ? theme.accent.primary : undefined}>
              {text}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
