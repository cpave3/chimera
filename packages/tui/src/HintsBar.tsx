import { Text } from 'ink';
import React, { memo } from 'react';

export interface HintsBarProps {
  mutedColor: string;
}

/**
 * The bottom shortcut bar — a single <Text> so StatusBar sees it as one
 * widget and still inserts the separator between it and neighbours.
 */
export const HintsBar = memo(function HintsBar({ mutedColor }: HintsBarProps): React.ReactElement {
  return (
    <Text color={mutedColor}>
      {
        '\\<Enter> newline · Ctrl+G editor · Ctrl+Z suspend · Esc/Ctrl+C interrupt · / commands · Shift+Tab cycle mode'
      }
    </Text>
  );
});
