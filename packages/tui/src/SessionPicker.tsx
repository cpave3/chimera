import type { SessionId, SessionInfo } from '@chimera/core';
import { Box, Text, useInput } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import { useFrame } from './frame';
import { buildSessionTreeRows, formatRelativeTime } from './session-tree';
import { useTheme } from './theme/ThemeProvider';
import { useHighlight } from './use-highlight';

export interface SessionPickerProps {
  sessions: SessionInfo[];
  currentSessionId: SessionId;
  onSelect: (id: SessionId) => void;
  onCancel: () => void;
}

function basename(p: string): string {
  if (!p) return '';
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export function SessionPicker(props: SessionPickerProps): React.ReactElement {
  const theme = useTheme();
  const frame = useFrame('round');
  const rows = useMemo(() => buildSessionTreeRows(props.sessions), [props.sessions]);
  const { highlight, current, move } = useHighlight(() => {
    const idx = rows.findIndex((r) => r.info.id === props.currentSessionId);
    return idx >= 0 ? idx : 0;
  });
  // Keep "Xm ago" labels current — refresh once a minute while mounted.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(handle);
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      const row = rows[current.current];
      if (row) props.onSelect(row.info.id);
      return;
    }
    if (key.upArrow || (input === 'k' && !key.ctrl && !key.meta)) {
      move((index) => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow || (input === 'j' && !key.ctrl && !key.meta)) {
      move((index) => Math.min(rows.length - 1, index + 1));
      return;
    }
  });

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" borderStyle={frame} paddingX={1}>
        <Text>No persisted sessions. Press Esc to close.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle={frame} paddingX={1}>
      <Text bold>Sessions ({rows.length})</Text>
      <Text color={theme.text.muted}>↑/↓ navigate · Enter switch · Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row, idx) => {
          const isCurrent = row.info.id === props.currentSessionId;
          const isHighlighted = idx === highlight;
          const truncId = row.info.id.slice(-8);
          const childMark = row.info.children.length > 0 ? `(${row.info.children.length})` : '   ';
          const rel = formatRelativeTime(now, row.info.createdAt);
          const cwdName = basename(row.info.cwd) || row.info.cwd;
          const displayName = row.info.name ?? cwdName;
          const marker = isCurrent ? '←' : ' ';
          const text = `${row.prefix}${truncId} ${childMark}  ${rel.padEnd(10)}  ${row.info.messageCount} msg  ${displayName} ${marker}`;
          return (
            <Text
              key={row.info.id}
              color={isHighlighted ? theme.accent.primary : undefined}
              inverse={isHighlighted}
              bold={isCurrent}
            >
              {text}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
