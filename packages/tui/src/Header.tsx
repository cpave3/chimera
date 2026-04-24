import { Box, Text } from 'ink';
import React from 'react';
import type { Theme } from './theme';

export interface HeaderProps {
  version: string;
  modelRef: string;
  cwd: string;
  sessionId: string;
  theme: Theme;
}

export function Header({ version, modelRef, cwd, sessionId, theme }: HeaderProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text color={theme.primary} bold>Chimera</Text>
        <Text color={theme.muted}>{`  v${version}`}</Text>
      </Box>
      <Text color={theme.secondary}>{modelRef}</Text>
      <Text color={theme.muted}>{cwd}</Text>
      <Text color={theme.muted}>{`session ${sessionId.slice(-8)}`}</Text>
    </Box>
  );
}
