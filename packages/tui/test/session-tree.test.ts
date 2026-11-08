import type { SessionInfo } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { buildSessionTreeRows } from '../src/session-tree';

function info(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    id: overrides.id,
    parentId: null,
    children: [],
    cwd: '/tmp/proj',
    createdAt: 1_700_000_000_000,
    model: { providerId: 'p', modelId: 'm', maxSteps: 100 },
    sandboxMode: 'off',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
    },
    messageCount: 0,
    ...overrides,
  } as SessionInfo;
}

describe('buildSessionTreeRows', () => {
  it('orders roots by createdAt descending', () => {
    const sessions = [
      info({ id: 'a', createdAt: 1 }),
      info({ id: 'b', createdAt: 3 }),
      info({ id: 'c', createdAt: 2 }),
    ];
    const rows = buildSessionTreeRows(sessions);
    expect(rows.map((r) => r.info.id)).toEqual(['b', 'c', 'a']);
  });

  it('inlines descendants under their parent in createdAt-ascending order', () => {
    const sessions = [
      info({ id: 'root', createdAt: 100, children: ['c1', 'c2'] }),
      info({ id: 'c1', parentId: 'root', createdAt: 200 }),
      info({ id: 'c2', parentId: 'root', createdAt: 150 }),
    ];
    const rows = buildSessionTreeRows(sessions);
    expect(rows.map((r) => r.info.id)).toEqual(['root', 'c2', 'c1']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1]);
  });

  it('treats orphaned children as roots', () => {
    const sessions = [info({ id: 'orphan', parentId: 'missing', createdAt: 50 })];
    const rows = buildSessionTreeRows(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.info.id).toBe('orphan');
    expect(rows[0]!.depth).toBe(0);
  });

  it('renders branch glyphs at the right depth', () => {
    const sessions = [
      info({ id: 'root', createdAt: 100, children: ['c1', 'c2'] }),
      info({ id: 'c1', parentId: 'root', createdAt: 110 }),
      info({ id: 'c2', parentId: 'root', createdAt: 120 }),
    ];
    const rows = buildSessionTreeRows(sessions);
    expect(rows[0]!.prefix).toBe('');
    expect(rows[1]!.prefix).toBe('├─ ');
    expect(rows[2]!.prefix).toBe('└─ ');
  });
});
