import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from './theme/ThemeProvider';

export interface HeaderProps {
  version: string;
  modelRef: string;
  cwd: string;
  sessionId: string;
}

export function Header({ version, modelRef, cwd, sessionId }: HeaderProps): React.ReactElement {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent.primary}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text color={theme.accent.primary} bold>Chimera</Text>
        <Text color={theme.text.muted}>{`  v${version}`}</Text>
      </Box>
      <Text color={theme.accent.secondary}>{modelRef}</Text>
      <Text color={theme.text.muted}>{cwd}</Text>
      <Text color={theme.text.muted}>{`session ${sessionId.slice(-8)}`}</Text>
    </Box>
  );
}
