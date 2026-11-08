import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Mounted, mount, runFinished, settle, text, toolCall, userMessage } from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** SGR mouse report for the cell at zero-based (x, y). */
const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const drag = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`;
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;
const wheelUp = '\x1b[<64;5;5M';

function rowOf(mounted: Mounted, needle: string): number {
  return mounted.term.screen().findIndex((row) => row.includes(needle));
}

async function withMessages(count: number, size = { columns: 80, rows: 20 }) {
  const ready = await mount({ writeClipboard: vi.fn(async () => true) }, size);
  for (let index = 0; index < count; index += 1)
    ready.session.push(userMessage(`message ${index}`));
  await settle(80);
  return ready;
}

describe('mouse in the fullscreen layout', () => {
  it('scrolls the transcript with the wheel', async () => {
    mounted = await withMessages(30);
    expect(mounted.screen()).toContain('message 29');
    await mounted.keys(wheelUp + wheelUp + wheelUp);
    expect(mounted.screen()).not.toContain('message 29');
  });

  it('copies a drag selection on release, through OSC 52 and the clipboard tool, and says so', async () => {
    const writeClipboard = vi.fn(async () => true);
    mounted = await mount({ writeClipboard });
    await mounted.event(text('First line of the answer.\n\nSecond paragraph here.'), runFinished);
    const first = rowOf(mounted, 'First line');
    const second = rowOf(mounted, 'Second paragraph');
    await mounted.keys(press(9, first) + drag(20, second) + release(20, second));
    expect(writeClipboard).toHaveBeenCalledWith('First line of the answer.\n\nSecond parag');
    expect(mounted.term.osc.some((sequence) => sequence.startsWith('52;c;'))).toBe(true);
    expect(mounted.screen()).toMatch(/copied 39 characters ─╮/);
  });

  it('drops the indent a selection starts in, and copies code without its gutter', async () => {
    const writeClipboard = vi.fn(async () => true);
    mounted = await mount({ writeClipboard });
    await mounted.event(text('Code:\n\n```\nif (ready) {\n  start();\n}\n```'), runFinished);
    const top = rowOf(mounted, 'if (ready)');
    const bottom = rowOf(mounted, '┆ }');
    await mounted.keys(press(4, top) + drag(12, bottom) + release(12, bottom));
    expect(writeClipboard).toHaveBeenCalledWith('if (ready) {\n  start();\n}');
  });

  it('expands and collapses one tool call when it is clicked', async () => {
    mounted = await mount();
    const stdout = Array.from({ length: 8 }, (_, i) => `out ${i + 1}`).join('\n');
    await mounted.event(
      ...toolCall(
        'c1',
        'bash',
        { command: 'ls' },
        'ls',
        { stdout, stderr: '', exit_code: 0 },
        'ls (exit 0)',
      ),
      ...toolCall(
        'c2',
        'bash',
        { command: 'pwd' },
        'pwd',
        { stdout, stderr: '', exit_code: 0 },
        'pwd (exit 0)',
      ),
      runFinished,
    );
    const row = rowOf(mounted, 'bash  ls');
    await mounted.keys(press(5, row) + release(5, row));
    const screen = mounted.screen();
    expect(screen).toContain('out 8');
    expect(screen.match(/… 5 more · ctrl\+o/g)).toHaveLength(1);
    await mounted.keys(press(5, row) + release(5, row));
    expect(mounted.screen().match(/… 5 more · ctrl\+o/g)).toHaveLength(2);
  });
});

describe('scroll position', () => {
  it('shows a scrollbar thumb at the bottom, middle and top, with indicators when away', async () => {
    mounted = await withMessages(60, { columns: 80, rows: 20 });
    const thumbRows = () =>
      mounted!.term
        .screen()
        .map((row, index) => (row.padEnd(80)[79] === '┃' ? index : -1))
        .filter((index) => index >= 0);
    const atBottom = thumbRows();
    expect(atBottom.length).toBeGreaterThan(0);
    await mounted.keys('\x1b[1;5H');
    const atTop = thumbRows();
    expect(atTop[0]).toBe(0);
    expect(atBottom.at(-1)).toBeGreaterThan(atTop.at(-1)!);
    expect(mounted.term.screen()[0]).not.toContain('earlier lines');
    expect(mounted.screen()).toContain('newer lines · jump to latest · ctrl+end');
    await mounted.keys('\x1b[6~\x1b[6~');
    const middle = thumbRows();
    expect(middle[0]).toBeGreaterThan(atTop[0]!);
    expect(middle[0]).toBeLessThan(atBottom[0]!);
    expect(mounted.term.screen()[0]).toMatch(/▲ \d+ earlier lines/);
  });
});

describe('search', () => {
  it('finds matches in collapsed and expanded entries, steps through them, and closes on Esc', async () => {
    mounted = await mount({}, { columns: 80, rows: 24 });
    const stdout = ['alpha', 'beta', 'gamma', 'delta', 'needle in the output', 'omega'].join('\n');
    await mounted.event(
      userMessage('find the needle'),
      ...toolCall(
        'c1',
        'bash',
        { command: 'cat x' },
        'cat x',
        { stdout, stderr: '', exit_code: 0 },
        'cat x (exit 0)',
      ),
      text('No needle here, just text.'),
      runFinished,
    );
    expect(mounted.screen()).not.toContain('needle in the output');
    await mounted.keys('\x06needle');
    expect(mounted.screen()).toMatch(/find {2}› needle .* –\/3 · enter next/);
    // Enter starts at the newest match and walks back through the transcript.
    await mounted.keys('\r');
    expect(mounted.screen()).toMatch(/3\/3 · enter next/);
    await mounted.keys('\r');
    expect(mounted.screen()).toMatch(/2\/3 · enter next/);
    // That match was in collapsed output: its entry opened.
    expect(mounted.screen()).toContain('needle in the output');
    await mounted.keys('\x1b[13;2u');
    expect(mounted.screen()).toMatch(/3\/3 · enter next/);
    await mounted.keys('\x10');
    expect(mounted.screen()).toMatch(/1\/3 · enter next/);
    await mounted.keys('\x1b', 120);
    expect(mounted.screen()).not.toContain('find  ›');
    await mounted.keys('x');
    expect(mounted.screen()).toContain('│ › x');
  });
});

describe('exit', () => {
  it('leaves the transcript on the main screen in the inline form', async () => {
    mounted = await mount({}, { columns: 80, rows: 20 });
    mounted.term.write('$ chimera\r\n');
    await mounted.event(userMessage('remember this'), text('The answer stays.'), runFinished);
    mounted.handle.unmount();
    await settle(10);
    expect(mounted.term.alternate).toBe(false);
    const history = mounted.term.history();
    expect(history).toContain('    you  remember this');
    expect(history).toContain('         The answer stays.');
    expect(history.some((row) => row.startsWith('╭─'))).toBe(false);
    mounted = undefined;
  });
});
