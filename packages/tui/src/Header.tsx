import { Box, Text } from 'ink';
import React from 'react';
import { displayPath } from './display-path';
import { useTheme } from './theme/ThemeProvider';
import type { SandboxLabel } from './view';

export interface HeaderProps {
  version: string;
  modelRef: string;
  cwd: string;
  sessionId: string;
  mode: string;
  sandboxMode: SandboxLabel;
  skillCount: number;
  commandCount: number;
}

const LABEL_WIDTH = 9;

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/** The banner printed once at the top of a session: what it runs on and where. */
export function Header({
  version,
  modelRef,
  cwd,
  sessionId,
  mode,
  sandboxMode,
  skillCount,
  commandCount,
}: HeaderProps): React.ReactElement {
  const theme = useTheme();
  const loaded = [
    ...(skillCount > 0 ? [count(skillCount, 'skill')] : []),
    ...(commandCount > 0 ? [count(commandCount, 'command')] : []),
  ];
  const rows: Array<[label: string, value: string, color: string]> = [
    ['model', modelRef, theme.accent.secondary],
    ['cwd', displayPath(cwd, 72), theme.text.primary],
    [
      'session',
      `${sessionId.slice(-8)} · mode ${mode} · sandbox ${sandboxMode}`,
      theme.text.primary,
    ],
    ...(loaded.length > 0
      ? [['loaded', loaded.join(' · '), theme.text.primary] as [string, string, string]]
      : []),
  ];
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent.primary}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text color={theme.accent.primary} bold>
          Chimera
        </Text>
        <Text color={theme.text.muted}>{`  v${version}`}</Text>
      </Box>
      {rows.map(([label, value, color]) => (
        <Text key={label}>
          <Text color={theme.text.muted}>{label.padEnd(LABEL_WIDTH)}</Text>
          <Text color={color}>{value}</Text>
        </Text>
      ))}
    </Box>
  );
}
