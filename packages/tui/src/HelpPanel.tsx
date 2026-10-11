import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from './theme/ThemeProvider';

const KEY_BINDINGS: Array<[keys: string, action: string]> = [
  ['Enter', 'send; during a run, steer the agent'],
  ['Tab', 'during a run, hold the message for the next turn'],
  ['\\ then Enter', 'new line (also Shift+Enter or Alt+Enter where supported)'],
  ['Ctrl+G', 'edit the prompt in $EDITOR'],
  ['Ctrl+V', 'paste an image'],
  ['Ctrl+T', 'open the full transcript in a pager'],
  ['Up / Down', 'prompt history'],
  ['Shift+Tab', 'cycle mode'],
  ['/', 'commands; Tab completes'],
  ['@path  #path', 'attach a file to read / to write'],
  ['!command', 'run a shell command'],
  ['Esc', 'interrupt the run'],
  ['Ctrl+C', 'interrupt; press twice to exit'],
  ['Ctrl+Z', 'suspend'],
];

/** Keys that exist only where the TUI owns the screen. */
const FULLSCREEN_KEY_BINDINGS: Array<[keys: string, action: string]> = [
  ['PgUp / PgDn', 'scroll the transcript (also the mouse wheel)'],
  ['Ctrl+B', 'show or hide the context panel'],
  ['Drag', 'select text; it is copied when you release the button'],
  ['Shift+drag', "select with the terminal's own selection instead"],
];

const KEY_COLUMN_WIDTH = Math.max(...KEY_BINDINGS.map(([keys]) => keys.length)) + 2;

/** The key bindings, shown on `?` at an empty prompt instead of a permanent hints row. */
export function HelpPanel({ fullscreen = false }: { fullscreen?: boolean }): React.ReactElement {
  const theme = useTheme();
  const bindings = fullscreen ? [...KEY_BINDINGS, ...FULLSCREEN_KEY_BINDINGS] : KEY_BINDINGS;
  return (
    <Box flexDirection="column" marginTop={1}>
      {bindings.map(([keys, action]) => (
        <Text key={keys}>
          <Text color={theme.accent.primary}>{keys.padEnd(KEY_COLUMN_WIDTH)}</Text>
          <Text color={theme.text.muted}>{action}</Text>
        </Text>
      ))}
    </Box>
  );
}
