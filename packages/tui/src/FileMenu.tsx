import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from './theme/ThemeProvider';

export interface FileMenuProps {
  /** Ranked paths, best first. */
  paths: string[];
  highlightIdx: number;
}

/** The file list that opens under an `@` or `#` word in the prompt. */
export function FileMenu({ paths, highlightIdx }: FileMenuProps): React.ReactElement {
  const theme = useTheme();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.text.muted}>
      {paths.map((path, index) => (
        <Text key={path} inverse={index === highlightIdx} wrap="truncate">
          <Text color={index === highlightIdx ? undefined : theme.accent.primary}>{path}</Text>
        </Text>
      ))}
    </Box>
  );
}
