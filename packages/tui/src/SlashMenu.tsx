import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from './theme/ThemeProvider';

export interface SlashMenuItem {
  /** Command name without the leading slash. */
  name: string;
  description?: string;
  kind: 'builtin' | 'user' | 'skill';
}

export interface SlashMenuProps {
  items: SlashMenuItem[];
  highlightIdx: number;
}

export const SLASH_MENU_MAX_ROWS = 8;

export function SlashMenu({ items, highlightIdx }: SlashMenuProps): React.ReactElement {
  const theme = useTheme();
  const start = Math.max(
    0,
    Math.min(
      Math.max(0, items.length - SLASH_MENU_MAX_ROWS),
      highlightIdx - Math.floor(SLASH_MENU_MAX_ROWS / 2),
    ),
  );
  const visible = items.slice(start, start + SLASH_MENU_MAX_ROWS);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.text.muted}>
      {visible.map((item, i) => {
        const idx = start + i;
        const selected = idx === highlightIdx;
        const badge =
          item.kind === 'builtin' ? 'built-in' : item.kind === 'skill' ? 'skill' : 'user';
        return (
          <Text key={item.name} inverse={selected}>
            <Text color={selected ? undefined : theme.accent.primary}>/{item.name}</Text>
            <Text color={selected ? undefined : theme.text.muted}>
              {`  ${badge.padEnd(8)} `}
              {item.description ?? ''}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
