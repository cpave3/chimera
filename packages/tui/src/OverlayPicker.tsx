import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import { useTheme } from './theme/ThemeProvider';

export interface OverlayDiffEntry {
  kind: 'modified' | 'added' | 'deleted';
  path: string;
}

export interface OverlayPickerProps {
  entries: OverlayDiffEntry[];
  /** Called once with the user's selection, or null for cancel/discard. */
  onResolve(selection: { paths: string[] } | null): void;
}

const HINT = 'space toggle · a all · n none · enter apply · esc cancel';

export function OverlayPicker({ entries, onResolve }: OverlayPickerProps): React.ReactElement {
  const theme = useTheme();
  const [selected, setSelected] = useState<Set<number>>(() => new Set(entries.map((_, i) => i)));
  const [cursor, setCursor] = useState(0);

  useInput((char, key) => {
    if (key.escape) {
      onResolve(null);
      return;
    }
    if (key.return) {
      const paths = entries.filter((_, i) => selected.has(i)).map((e) => e.path);
      onResolve({ paths });
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(entries.length - 1, c + 1));
      return;
    }
    if (char === ' ') {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
      return;
    }
    if (char === 'a') {
      setSelected(new Set(entries.map((_, i) => i)));
      return;
    }
    if (char === 'n') {
      setSelected(new Set());
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent.primary} paddingX={1}>
      <Text color={theme.accent.primary} bold>
        Overlay changes — choose which to apply
      </Text>
      {entries.length === 0 && <Text color={theme.text.muted}>(no changes)</Text>}
      {entries.map((e, i) => {
        const checked = selected.has(i);
        const here = i === cursor;
        const marker = checked ? '[x]' : '[ ]';
        const tag = e.kind === 'added' ? '+' : e.kind === 'deleted' ? '-' : '~';
        return (
          <Text key={`${e.kind}:${e.path}`} color={here ? theme.ui.accent : undefined}>
            {`${here ? '>' : ' '} ${marker} ${tag} ${e.path}`}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text color={theme.text.muted}>{HINT}</Text>
      </Box>
    </Box>
  );
}
