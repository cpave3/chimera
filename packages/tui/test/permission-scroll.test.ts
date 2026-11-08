import type { AgentEvent } from '@chimera/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mount, settle } from './harness';

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const WHEEL_UP = '\x1b[<64;1;1M';
const WHEEL_DOWN = '\x1b[<65;1;1M';

/** A command of `count` numbered lines: far taller than the 30-row test screen. */
function longCommand(count: number): string {
  return Array.from({ length: count }, (_, index) => `echo step ${index + 1} of ${count};`).join(
    '\n',
  );
}

const permissionRequest = (command: string): AgentEvent =>
  ({
    type: 'permission_request',
    requestId: 'r1',
    tool: 'bash',
    target: 'host',
    command,
  }) as AgentEvent;

/** The first line of the card's body in view, from its `lines a–b of n` row. */
function firstLineInView(screen: string): number {
  const position = /lines (\d+)–\d+ of \d+ · pgup\/pgdn/.exec(screen);
  if (!position) throw new Error(`no scroll position on screen:\n${screen}`);
  return Number(position[1]);
}

function expectChoicesInView(screen: string): void {
  expect(screen).toContain('approval needed');
  expect(screen).toContain('› a  Allow once');
  expect(screen).toContain('f  Deny with feedback…');
  expect(screen).toContain('│ › waiting for your answer above');
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('a permission card taller than the screen', () => {
  it('shows the top of the request, the choices and where the view is', async () => {
    mounted = await mount();
    await mounted.event(permissionRequest(longCommand(60)));
    const screen = mounted.screen();

    expectChoicesInView(screen);
    expect(screen).toContain('│ bash   echo step 1 of 60;');
    expect(screen).toMatch(/lines 1–\d+ of 60 · pgup\/pgdn/);
    expect(screen).not.toContain('echo step 60 of 60;');
  });

  it('scrolls the request with PageDown and PageUp, under choices that stay put', async () => {
    mounted = await mount();
    await mounted.event(permissionRequest(longCommand(60)));
    await mounted.keys(PAGE_DOWN);
    const lower = mounted.screen();
    await mounted.keys(PAGE_UP);
    const upper = mounted.screen();

    expect(lower).not.toContain('echo step 1 of 60;');
    expect(firstLineInView(lower)).toBeGreaterThan(1);
    expect(lower).toContain(`echo step ${firstLineInView(lower)} of 60;`);
    expectChoicesInView(lower);
    expect(firstLineInView(upper)).toBe(1);
    expect(upper).toContain('│ bash   echo step 1 of 60;');
    expectChoicesInView(upper);
  });

  it('scrolls the request three lines for one notch of the wheel', async () => {
    mounted = await mount();
    await mounted.event(permissionRequest(longCommand(60)));
    await mounted.keys(WHEEL_DOWN);
    const lower = mounted.screen();
    await mounted.keys(WHEEL_UP);
    const upper = mounted.screen();

    expect(firstLineInView(lower)).toBe(4);
    expect(lower).not.toContain('echo step 3 of 60;');
    expect(lower).toContain('echo step 4 of 60;');
    expectChoicesInView(lower);
    expect(firstLineInView(upper)).toBe(1);
  });
});

describe('a permission card that fits', () => {
  async function mountUnderTranscript(): Promise<Mounted> {
    const fitted = await mount();
    for (let number = 1; number <= 40; number += 1) {
      fitted.session.push({ type: 'user_message', content: `message number ${number}.` });
    }
    await settle(60);
    await fitted.event(permissionRequest(longCommand(3)));
    return fitted;
  }

  it('says nothing about scrolling', async () => {
    mounted = await mountUnderTranscript();
    const screen = mounted.screen();

    expect(screen).toContain('echo step 3 of 3;');
    expect(screen).not.toContain('pgup/pgdn');
    expectChoicesInView(screen);
  });

  it('lets PageUp and the wheel scroll the transcript under it', async () => {
    mounted = await mountUnderTranscript();
    expect(mounted.screen()).toContain('message number 40.');
    await mounted.keys(PAGE_UP);
    const paged = mounted.screen();
    await mounted.keys(PAGE_DOWN);
    await mounted.keys(WHEEL_UP);
    const wheeled = mounted.screen();

    expect(paged).not.toContain('message number 40.');
    expect(paged).toContain('echo step 1 of 3;');
    expectChoicesInView(paged);
    expect(wheeled).not.toContain('message number 39.');
    expect(wheeled).toContain('message number 38.');
    expectChoicesInView(wheeled);
    expect(mounted.session.resolutions).toEqual([]);
  });
});

describe('a permission card taller than the terminal, in the inline layout', () => {
  it('keeps the choices on screen and scrolls the request under them', async () => {
    mounted = await mount({ layout: 'inline' }, { columns: 100, rows: 30 });
    await mounted.event(permissionRequest(longCommand(60)));
    const top = mounted.screen();
    await mounted.keys(PAGE_DOWN);
    const lower = mounted.screen();

    expectChoicesInView(top);
    expect(top).toContain('│ bash   echo step 1 of 60;');
    expect(firstLineInView(top)).toBe(1);
    expect(top).not.toContain('echo step 60 of 60;');
    expectChoicesInView(lower);
    expect(lower).not.toContain('echo step 1 of 60;');
    expect(firstLineInView(lower)).toBeGreaterThan(1);
    expect(lower).toContain(`echo step ${firstLineInView(lower)} of 60;`);
  });
});
