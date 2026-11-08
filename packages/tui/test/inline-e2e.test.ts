import type { AgentEvent } from '@chimera/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mount, runFinished, settle, text, toolCall, userMessage } from './harness';

const CLEAR_ALL = '\x1b[2J\x1b[H\x1b[3J';
const ERASE_LINE = '\x1b[2K';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const inline = (size = { columns: 80, rows: 20 }) => mount({ layout: 'inline' }, size);

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('the inline layout', () => {
  it('writes into the main screen, the transcript followed by the prompt box', async () => {
    mounted = await inline();
    await mounted.event(userMessage('hello'));
    expect(mounted.term.alternate).toBe(false);
    const history = mounted.term.history();
    expect(history[0]).toMatch(/^chimera {2}v9\.9\.9/);
    expect(history).toContain('    you  hello');
    expect(history.at(-4)).toMatch(/^╭─ build ─+ \? help ─╮$/);
    expect(history.at(-1)).toBe('   8AWWBRGC');
  });

  it('never captures the mouse', async () => {
    mounted = await inline();
    await mounted.keys('a');
    expect(mounted.term.modes.has(1002)).toBe(false);
    expect(mounted.term.modes.has(1006)).toBe(false);
    expect(mounted.term.output).not.toContain('\x1b[?1002h');
  });

  it('rewrites only the changed rows while a long reply streams', async () => {
    mounted = await inline({ columns: 80, rows: 20 });
    await mounted.event(userMessage('write a lot'));
    mounted.term.takeOutput();
    let written = '';
    for (let line = 0; line < 60; line += 1) {
      await mounted.event(
        text(`${line === 0 ? '' : '\n\n'}Paragraph number ${line} of the reply.`),
      );
      const frame = mounted.term.takeOutput();
      expect(frame).not.toContain(CLEAR_ALL);
      // The changed rows: the new paragraph and its gap, and the prompt box under it.
      expect(count(frame, ERASE_LINE)).toBeLessThanOrEqual(8);
      written += frame;
    }
    expect(mounted.term.syncFrames).toBeGreaterThan(0);
    expect(written).not.toContain(CLEAR_ALL);
  });

  it('scrolls a reply taller than the screen into the scrollback once, without duplicates', async () => {
    mounted = await inline({ columns: 80, rows: 12 });
    await mounted.event(userMessage('go'));
    for (let line = 0; line < 40; line += 1)
      mounted.session.push(text(`${line === 0 ? '' : '\n\n'}line ${line}`));
    await mounted.event(runFinished);
    const history = mounted.term.history().filter((row) => /line \d+$/.test(row));
    expect(history).toEqual(Array.from({ length: 40 }, (_, line) => `         line ${line}`));
  });

  it('reprints exactly once after a resize, at the new width', async () => {
    mounted = await inline({ columns: 80, rows: 12 });
    for (let index = 0; index < 20; index += 1)
      mounted.session.push(userMessage(`message ${index} with some words`));
    await settle(60);
    mounted.term.takeOutput();
    mounted.term.resize(40, 12);
    await settle(60);
    expect(count(mounted.term.takeOutput(), CLEAR_ALL)).toBe(1);
    const history = mounted.term.history();
    for (const row of history) expect(row.length).toBeLessThanOrEqual(40);
    expect(history.filter((row) => row.includes('message 7 with'))).toHaveLength(1);
  });

  it('reprints when Ctrl+O changes an entry above the screen', async () => {
    mounted = await inline({ columns: 80, rows: 12 });
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
    );
    for (let index = 0; index < 15; index += 1) mounted.session.push(userMessage(`later ${index}`));
    await settle(60);
    expect(mounted.term.history()).not.toContain('         out 8');
    mounted.term.takeOutput();
    await mounted.keys('\x0f');
    expect(mounted.term.takeOutput()).toContain(CLEAR_ALL);
    const history = mounted.term.history();
    expect(history).toContain('         out 8');
    expect(history.filter((row) => row === '   bash  ls  1.2s')).toHaveLength(1);
  });

  it('leaves the transcript in the scrollback on exit, without the prompt box', async () => {
    mounted = await inline();
    await mounted.event(userMessage('keep me'), text('An answer.'), runFinished);
    mounted.handle.unmount();
    await settle(10);
    const history = mounted.term.history();
    expect(history).toContain('    you  keep me');
    expect(history).toContain('         An answer.');
    expect(history.some((row) => row.startsWith('╭─'))).toBe(false);
    expect(mounted.term.modes.has(25)).toBe(true);
    expect(mounted.term.kittyFlags).toEqual([]);
    mounted = undefined;
  });
});

describe('without a terminal', () => {
  it('falls back to the inline layout and writes no mode sequences', async () => {
    mounted = await mount({}, { columns: 80, rows: 20, isTTY: false });
    expect(mounted.handle.layout).toBe('inline');
    await mounted.event({ type: 'user_message', content: 'piped' } as AgentEvent);
    expect(mounted.term.history()).toContain('    you  piped');
    expect(mounted.term.output).not.toContain('\x1b[>1u');
    expect(mounted.term.output).not.toContain('\x1b[?2004h');
  });
});
