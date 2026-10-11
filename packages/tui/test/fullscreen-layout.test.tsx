import type { AgentEvent } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { mountFullscreen, plain, settle, usage } from './fullscreen-helpers';

const toolStart: AgentEvent = {
  type: 'tool_call_start',
  callId: 'c1' as never,
  name: 'bash',
  args: {},
  target: 'host',
  display: { summary: 'pnpm test' },
};

describe('fullscreen layout', () => {
  it('fills the terminal, with the prompt box and the hints row at the bottom', async () => {
    const { lastFrame, unmount } = mountFullscreen();
    await settle();
    const rows = plain(lastFrame()).split('\n');
    unmount();

    expect(rows).toHaveLength(30);
    expect(rows.join('\n')).toContain('› message chimera');
    expect(rows.at(-1)).toContain('BUILD');
    expect(rows.at(-1)).toContain('⇧⇥ mode · / commands · @ file · ^b panel · ? help');
  });

  it('puts the context panel beside the transcript', async () => {
    const { lastFrame, unmount } = mountFullscreen();
    await settle();
    const rows = plain(lastFrame()).split('\n');
    unmount();

    const header = rows.find((row) => row.includes('◆ chimera'));
    expect(header).toBeDefined();
    expect(header!.indexOf('◆ chimera')).toBeGreaterThan(55);
  });

  it('shows the keys that matter during a run', async () => {
    const { lastFrame, unmount, session } = mountFullscreen();
    session.push(toolStart);
    await settle();
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('enter steer · tab queue · esc interrupt');
    expect(frame).toContain('running pnpm test');
    expect(frame).toContain('○ bash pnpm test');
  });

  it('drops the panel on a narrow terminal and moves its key facts to the hints row', async () => {
    const { lastFrame, unmount, session } = mountFullscreen({
      terminalSize: { columns: 80, rows: 24 },
    });
    session.push(usage(76_000));
    await settle();
    const rows = plain(lastFrame()).split('\n');
    unmount();

    expect(rows.join('\n')).not.toContain('◆ chimera');
    expect(rows.at(-1)).toContain('manticore/gpt · 38%');
    expect(Math.max(...rows.map((row) => row.length))).toBeLessThanOrEqual(80);
  });

  it('hides and shows the panel on Ctrl+B', async () => {
    const { lastFrame, unmount, stdin } = mountFullscreen();
    await settle();
    stdin.write('\x02');
    await settle();
    const hidden = plain(lastFrame());
    stdin.write('\x02');
    await settle();
    const shown = plain(lastFrame());
    unmount();

    expect(hidden).not.toContain('◆ chimera');
    expect(shown).toContain('◆ chimera');
  });

  it('lists its own keys in the help panel', async () => {
    const { lastFrame, unmount, stdin } = mountFullscreen();
    await settle();
    stdin.write('?');
    await settle();
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('PgUp / PgDn');
    expect(frame).toContain('Ctrl+B');
    expect(frame).toContain('Shift+drag');
  });

  it('shows the working directory as a full path', async () => {
    const { lastFrame, unmount } = mountFullscreen({ cwd: '.' });
    await settle();
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toMatch(/cwd +\S*chimera\S*/);
  });
});

describe('startup notices', () => {
  it('open the transcript', async () => {
    const { lastFrame, unmount } = mountFullscreen({
      startupNotices: ['/repo/AGENTS.md is 50 KiB; only its first 32 KiB are used.'],
    });
    await settle();
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('/repo/AGENTS.md is 50 KiB');
  });
});
