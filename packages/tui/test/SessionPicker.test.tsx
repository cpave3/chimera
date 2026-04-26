import type { SessionInfo } from '@chimera/core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SessionPicker, buildSessionTreeRows } from '../src/SessionPicker';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { pickBaseTheme } from '../src/theme/loader';

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

function withTheme(node: React.ReactElement) {
  const theme = pickBaseTheme();
  return (
    <ThemeProvider theme={theme} isUserTheme={false}>
      {node}
    </ThemeProvider>
  );
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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

describe('SessionPicker', () => {
  it('renders sessions with the current one marked', async () => {
    const sessions = [
      info({ id: '01AAAAAAAAAAAAAAAAAAAAAAAA', createdAt: Date.now() }),
      info({ id: '01BBBBBBBBBBBBBBBBBBBBBBBB', createdAt: Date.now() - 60000 }),
    ];
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const r = render(
      withTheme(
        <SessionPicker
          sessions={sessions}
          currentSessionId="01BBBBBBBBBBBBBBBBBBBBBBBB"
          onSelect={onSelect}
          onCancel={onCancel}
        />,
      ),
    );
    await tick();
    const out = r.lastFrame() ?? '';
    expect(out).toContain('Sessions (2)');
    expect(out).toContain('AAAAAAAA');
    expect(out).toContain('BBBBBBBB');
    expect(out).toContain('←'); // current session marker
    r.unmount();
  });

  it('Enter calls onSelect with the highlighted session id', async () => {
    const sessions = [
      info({ id: '01AAAAAAAAAAAAAAAAAAAAAAAA', createdAt: 2 }),
      info({ id: '01BBBBBBBBBBBBBBBBBBBBBBBB', createdAt: 1 }),
    ];
    const onSelect = vi.fn();
    const r = render(
      withTheme(
        <SessionPicker
          sessions={sessions}
          currentSessionId="01AAAAAAAAAAAAAAAAAAAAAAAA"
          onSelect={onSelect}
          onCancel={vi.fn()}
        />,
      ),
    );
    await tick();
    // Highlighted should default to current session (index 0); press Enter
    r.stdin.write('\r');
    await tick();
    expect(onSelect).toHaveBeenCalledWith('01AAAAAAAAAAAAAAAAAAAAAAAA');
    r.unmount();
  });

  it('arrow-down then Enter selects the next row', async () => {
    const sessions = [
      info({ id: '01AAAAAAAAAAAAAAAAAAAAAAAA', createdAt: 2 }),
      info({ id: '01BBBBBBBBBBBBBBBBBBBBBBBB', createdAt: 1 }),
    ];
    const onSelect = vi.fn();
    const r = render(
      withTheme(
        <SessionPicker
          sessions={sessions}
          currentSessionId="01AAAAAAAAAAAAAAAAAAAAAAAA"
          onSelect={onSelect}
          onCancel={vi.fn()}
        />,
      ),
    );
    await tick();
    r.stdin.write('[B'); // ArrowDown
    await tick();
    r.stdin.write('\r'); // Enter
    await tick();
    expect(onSelect).toHaveBeenCalledWith('01BBBBBBBBBBBBBBBBBBBBBBBB');
    r.unmount();
  });

  it('Escape calls onCancel', async () => {
    const onCancel = vi.fn();
    const r = render(
      withTheme(
        <SessionPicker
          sessions={[info({ id: '01AAAAAAAAAAAAAAAAAAAAAAAA', createdAt: 1 })]}
          currentSessionId="01AAAAAAAAAAAAAAAAAAAAAAAA"
          onSelect={vi.fn()}
          onCancel={onCancel}
        />,
      ),
    );
    await tick();
    r.stdin.write(''); // Escape
    await tick();
    expect(onCancel).toHaveBeenCalled();
    r.unmount();
  });

  it('shows empty state when no sessions', async () => {
    const r = render(
      withTheme(
        <SessionPicker
          sessions={[]}
          currentSessionId="01AAAAAAAAAAAAAAAAAAAAAAAA"
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );
    await tick();
    const out = r.lastFrame() ?? '';
    expect(out).toContain('No persisted sessions');
    r.unmount();
  });
});
