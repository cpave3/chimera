import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mount, runFinished, toolCall } from './harness';

const UP = '\x1b[A';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function mountDuringRun(): Promise<Mounted> {
  const running = await mount();
  await running.event(...toolCall('c1', 'bash', { command: 'pnpm test' }, 'pnpm test'));
  return running;
}

describe('message queue', () => {
  it('holds a message for the next turn on Tab during a run', async () => {
    mounted = await mountDuringRun();
    await mounted.keys('also fix lint\t');

    expect(mounted.screen()).toContain(' queued  also fix lint');
    expect(mounted.screen()).not.toContain('› also fix lint');
    expect(mounted.session.appended).toEqual([]);
    expect(mounted.session.sent).toEqual([]);

    await mounted.event(runFinished);

    expect(mounted.session.sent).toEqual(['also fix lint']);
    expect(mounted.screen()).not.toContain('queued');
  });

  it('still steers the current run on Enter', async () => {
    mounted = await mountDuringRun();
    await mounted.keys('use vitest\r');

    expect(mounted.session.appended).toEqual(['use vitest']);
    expect(mounted.session.sent).toEqual([]);
  });

  it('takes the newest queued message back on Up at an empty prompt', async () => {
    mounted = await mountDuringRun();
    await mounted.keys('first\t');
    await mounted.keys('second\t');
    expect(mounted.screen()).toContain(' queued  first');
    expect(mounted.screen()).toMatch(/^ {9}second/m);

    await mounted.keys(UP);

    expect(mounted.screen()).toContain('│ › second');
    expect(mounted.screen()).toContain(' queued  first');
    expect(mounted.screen()).not.toMatch(/^ {9}second/m);
  });

  it('lists the three newest queued messages and says how many more wait', async () => {
    mounted = await mountDuringRun();
    for (const message of ['one', 'two', 'three', 'four', 'five']) {
      await mounted.keys(`${message}\t`);
    }
    const rows = mounted.term.screen().map((row) => row.trimEnd());
    const first = rows.indexOf(' queued  +2 more');

    expect(first).toBeGreaterThan(-1);
    expect(rows.slice(first, first + 4)).toEqual([
      ' queued  +2 more',
      '         three',
      '         four',
      '         five',
    ]);
    expect(rows.some((row) => /^ +(queued {2})?(one|two)$/.test(row))).toBe(false);
  });

  it('sends the whole queue as one message when the run ends', async () => {
    mounted = await mountDuringRun();
    await mounted.keys('one\t');
    await mounted.keys('two\t');
    await mounted.event(runFinished);

    expect(mounted.session.sent).toEqual(['one\n\ntwo']);
  });

  it('does not queue with Tab when no run is active', async () => {
    mounted = await mount();
    await mounted.keys('hello\t');

    expect(mounted.screen()).not.toContain('queued');
    expect(mounted.screen()).toContain('│ › hello');
  });
});
