import type { AgentEvent } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { type FakeSession, mountFullscreen, plain, settle, type } from './fullscreen-helpers';

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';

function say(session: FakeSession, count: number, from = 1): void {
  for (let number = from; number < from + count; number += 1) {
    session.push({ type: 'user_message', content: `message number ${number}.` } as AgentEvent);
  }
}

describe('fullscreen transcript scrolling', () => {
  it('follows the newest output', async () => {
    const { lastFrame, unmount, session } = mountFullscreen();
    say(session, 40);
    await settle(80);
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('message number 40.');
    expect(frame).not.toContain('message number 1.');
  });

  it('shows earlier output on PageUp and holds it while new output arrives', async () => {
    const { lastFrame, unmount, session, stdin } = mountFullscreen();
    say(session, 40);
    await settle(80);
    stdin.write(PAGE_UP);
    await settle();
    const scrolled = plain(lastFrame());
    say(session, 5, 41);
    await settle(80);
    const afterMore = plain(lastFrame());
    unmount();

    expect(scrolled).not.toContain('message number 40.');
    expect(scrolled).toContain('message number 20.');
    expect(scrolled).toContain('pgdn to the latest output');
    expect(afterMore).toContain('message number 20.');
    expect(afterMore).not.toContain('message number 45.');
  });

  it('follows again after PageDown reaches the end', async () => {
    const { lastFrame, unmount, session, stdin } = mountFullscreen();
    say(session, 40);
    await settle(80);
    stdin.write(PAGE_UP);
    await settle();
    stdin.write(PAGE_DOWN);
    await settle();
    say(session, 1, 41);
    await settle(80);
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('message number 41.');
    expect(frame).not.toContain('pgdn to the latest output');
  });

  it('returns to the end when the user sends a message', async () => {
    const { lastFrame, unmount, session, stdin } = mountFullscreen();
    say(session, 40);
    await settle(80);
    stdin.write(PAGE_UP);
    await settle();
    await type(stdin, 'next');
    stdin.write('\r');
    await settle();
    const frame = plain(lastFrame());
    unmount();

    expect(session.sent).toEqual(['next']);
    expect(frame).toContain('message number 40.');
  });

  it('scrolls three lines for one notch of the wheel', async () => {
    const { lastFrame, unmount, session, mouse } = mountFullscreen();
    say(session, 40);
    await settle(80);
    const before = plain(lastFrame());
    mouse.emit({ kind: 'wheel-up' });
    await settle();
    const after = plain(lastFrame());
    unmount();

    // A message and the blank line above it take two rows, so three lines
    // up take the last two messages off the screen.
    expect(before).toContain('message number 40.');
    expect(after).not.toContain('message number 39.');
    expect(after).toContain('message number 38.');
  });

  it('scrolls under an open permission prompt', async () => {
    const { lastFrame, unmount, session, stdin } = mountFullscreen();
    say(session, 40);
    session.push({
      type: 'permission_request',
      requestId: 'r1',
      tool: 'bash',
      target: 'host',
      command: 'rm -rf build',
    } as AgentEvent);
    await settle(80);
    stdin.write(PAGE_UP);
    await settle();
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('rm -rf build');
    expect(frame).not.toContain('message number 40.');
  });
});

describe('a long transcript', () => {
  const HEADER = '… 400 earlier entries · scroll up for more';

  /** Page up until the top of the mounted entries is on screen. */
  async function pageToTop(
    stdin: { write: (data: string) => void },
    lastFrame: () => string | undefined,
  ) {
    for (let page = 0; page < 60 && !plain(lastFrame()).includes(HEADER); page += 1) {
      stdin.write(PAGE_UP);
      await settle(30);
    }
  }

  it('mounts a window of the newest entries and says how many came before', async () => {
    const { lastFrame, unmount, session, stdin } = mountFullscreen();
    say(session, 700);
    await settle(400);
    await pageToTop(stdin, lastFrame);
    const top = plain(lastFrame());
    unmount();

    expect(top).toContain(HEADER);
    expect(top).toContain('message number 401.');
    expect(top).not.toContain('message number 400.');
  }, 20_000);

  it('mounts earlier entries on a scroll up from the top, and keeps the place', async () => {
    const { lastFrame, unmount, session, stdin } = mountFullscreen();
    say(session, 700);
    await settle(400);
    await pageToTop(stdin, lastFrame);
    stdin.write(PAGE_UP);
    await settle(300);
    const grown = plain(lastFrame());
    unmount();

    expect(grown).not.toContain(HEADER);
    expect(grown).toContain('message number 400.');
    expect(grown).toContain('message number 401.');
  }, 20_000);
});
