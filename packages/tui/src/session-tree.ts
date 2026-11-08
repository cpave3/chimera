import type { SessionId, SessionInfo } from '@chimera/core';

export interface SessionPickerRow {
  info: SessionInfo;
  /** Depth in the session tree (root = 0). */
  depth: number;
  /** Pre-rendered tree-prefix (e.g. `├── `, `│   └── `). */
  prefix: string;
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
