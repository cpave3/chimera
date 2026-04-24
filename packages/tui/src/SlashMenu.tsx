import { Box, Text } from 'ink';
import React from 'react';
import type { Theme } from './theme';

export interface SlashMenuItem {
  /** Command name without the leading slash. */
  name: string;
  description?: string;
  kind: 'builtin' | 'user';
}

export interface SlashMenuProps {
  items: SlashMenuItem[];
  highlightIdx: number;
  theme: Theme;
}

export const SLASH_MENU_MAX_ROWS = 8;

export function SlashMenu({ items, highlightIdx, theme }: SlashMenuProps): React.ReactElement {
  const start = Math.max(
    0,
    Math.min(
      Math.max(0, items.length - SLASH_MENU_MAX_ROWS),
      highlightIdx - Math.floor(SLASH_MENU_MAX_ROWS / 2),
    ),
  );
  const visible = items.slice(start, start + SLASH_MENU_MAX_ROWS);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.muted}>
      {visible.map((item, i) => {
        const idx = start + i;
        const selected = idx === highlightIdx;
        const badge = item.kind === 'builtin' ? 'built-in' : 'user';
        return (
          <Text key={item.name} inverse={selected}>
            <Text color={selected ? undefined : theme.primary}>/{item.name}</Text>
            <Text color={selected ? undefined : theme.muted}>
              {`  ${badge.padEnd(8)} `}
              {item.description ?? ''}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
