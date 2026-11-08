import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mount, settle, userMessage } from './harness';

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const WHEEL_UP = '\x1b[<64;1;1M';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function keyModesOn(term: Mounted['term']): boolean {
  return (
    term.kittyFlags.length > 0 &&
    term.modifyOtherKeys === 1 &&
    term.modes.has(2004) &&
    term.modes.has(1002)
  );
}

async function say(count: number, from = 1): Promise<void> {
  for (let number = from; number < from + count; number += 1) {
    mounted!.session.push(userMessage(`message number ${number}.`));
  }
  await settle(60);
}

describe('startup notices', () => {
  it('open the transcript, under the banner', async () => {
    mounted = await mount({
      startupNotices: ['/repo/AGENTS.md is 50 KiB; only its first 32 KiB are used.'],
    });
    const rows = mounted.term.screen();

    expect(rows[0]).toMatch(/^chimera {2}v9\.9\.9/);
    expect(rows[1]).toBe('   note  /repo/AGENTS.md is 50 KiB; only its first 32 KiB are used.');
  });
});

describe('the pager', () => {
  it('gives the screen back when it fails to start, and says why', async () => {
    mounted = await mount({ openInPager: async () => ({ ok: false, reason: 'less: not found' }) });
    await mounted.keys('\x14');

    expect(mounted.screen()).toContain('   note  transcript: less: not found');
    expect(mounted.term.alternate).toBe(true);
    expect(keyModesOn(mounted.term)).toBe(true);
    expect(mounted.screen()).toMatch(/╭─ build/);
  });
});

describe('the session on screen', () => {
  it('is reported at start', async () => {
    mounted = await mount();

    expect(mounted.handle.activeSessionId()).toBe('01ABCDEFGH8AWWBRGC');
  });
});

describe('scrolling the transcript', () => {
  it('scrolls three lines for one notch of the wheel', async () => {
    mounted = await mount();
    await say(40);
    expect(mounted.screen()).toContain('message number 40.');
    await mounted.keys(WHEEL_UP);

    // A message and the blank line above it take two rows, so three lines
    // up take the last two messages off the screen.
    expect(mounted.screen()).not.toContain('message number 39.');
    expect(mounted.screen()).toContain('message number 38.');
  });

  it('follows the newest output again once PageDown reaches the end', async () => {
    mounted = await mount();
    await say(40);
    await mounted.keys(PAGE_UP);
    expect(mounted.screen()).not.toContain('message number 40.');
    await mounted.keys(PAGE_DOWN);
    await say(1, 41);

    expect(mounted.screen()).toContain('message number 41.');
  });
});
