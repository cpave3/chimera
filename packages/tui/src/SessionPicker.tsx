import { Box, Text, useInput } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import type { SessionInfo, SessionId } from '@chimera/core';
import { useTheme } from './theme/ThemeProvider';

export interface SessionPickerRow {
  info: SessionInfo;
  /** Depth in the session tree (root = 0). */
  depth: number;
  /** Pre-rendered tree-prefix (e.g. `├── `, `│   └── `). */
  prefix: string;
}

export interface SessionPickerProps {
  sessions: SessionInfo[];
  currentSessionId: SessionId;
  onSelect: (id: SessionId) => void;
  onCancel: () => void;
}

/**
 * Build the row order for the picker: roots descending by `createdAt`, with
 * each root's descendants depth-first immediately under it. Returns rows
 * with their depth and a pre-computed tree-prefix.
 */
export function buildSessionTreeRows(sessions: SessionInfo[]): SessionPickerRow[] {
  const byId = new Map<SessionId, SessionInfo>();
  for (const s of sessions) byId.set(s.id, s);
  const roots = sessions
    .filter((s) => s.parentId === null || !byId.has(s.parentId))
    .sort((a, b) => b.createdAt - a.createdAt);
  const rows: SessionPickerRow[] = [];
  function visit(node: SessionInfo, depth: number, ancestorTrails: boolean[]): void {
    const childIds = node.children.filter((cid) => byId.has(cid));
    const children = childIds
      .map((cid) => byId.get(cid)!)
      .sort((a, b) => a.createdAt - b.createdAt);
    let prefix = '';
    for (let i = 0; i < ancestorTrails.length - 1; i++) {
      prefix += ancestorTrails[i] ? '│  ' : '   ';
    }
    if (depth > 0) {
      prefix += ancestorTrails[ancestorTrails.length - 1] ? '├─ ' : '└─ ';
    }
    rows.push({ info: node, depth, prefix });
    for (let i = 0; i < children.length; i++) {
      const isLast = i === children.length - 1;
      visit(children[i]!, depth + 1, [...ancestorTrails, !isLast]);
    }
  }
  for (const root of roots) {
    visit(root, 0, []);
  }
  return rows;
}

export function formatRelativeTime(now: number, then: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function basename(p: string): string {
  if (!p) return '';
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export function SessionPicker(props: SessionPickerProps): React.ReactElement {
  const theme = useTheme();
  const rows = useMemo(() => buildSessionTreeRows(props.sessions), [props.sessions]);
  const [highlight, setHighlight] = useState<number>(() => {
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
      const row = rows[highlight];
      if (row) props.onSelect(row.info.id);
      return;
    }
    if (key.upArrow || (input === 'k' && !key.ctrl && !key.meta)) {
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.downArrow || (input === 'j' && !key.ctrl && !key.meta)) {
      setHighlight((h) => Math.min(rows.length - 1, h + 1));
      return;
    }
  });

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text>No persisted sessions. Press Esc to close.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
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
          const marker = isCurrent ? '←' : ' ';
          const text = `${row.prefix}${truncId} ${childMark}  ${rel.padEnd(10)}  ${row.info.messageCount} msg  ${cwdName} ${marker}`;
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
