import { describe, expect, it } from 'vitest';
import { AltScreen } from '../src/terminal/alt-screen';
import { InlineScreen } from '../src/terminal/inline-screen';
import { VirtualTerminal } from '../src/terminal/virtual-terminal';

const CLEAR_ALL = '\x1b[2J\x1b[H\x1b[3J';
const ERASE_LINE = '\x1b[2K';

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function lines(prefix: string, length: number): string[] {
  return Array.from({ length }, (_, i) => `${prefix}${i}`);
}

describe('InlineScreen', () => {
  function setup(columns = 20, rows = 5) {
    const term = new VirtualTerminal({ columns, rows });
    term.write('$ chimera\r\n');
    term.takeOutput();
    return { term, screen: new InlineScreen(term) };
  }

  it('writes the first frame under the shell line and appends new lines', () => {
    const { term, screen } = setup();
    screen.render(['one', 'two']);
    expect(term.history()).toEqual(['$ chimera', 'one', 'two']);
    term.takeOutput();
    screen.render(['one', 'two', 'three']);
    const output = term.takeOutput();
    expect(term.history()).toEqual(['$ chimera', 'one', 'two', 'three']);
    expect(output).not.toContain('one');
    expect(count(output, ERASE_LINE)).toBe(1);
  });

  it('rewrites only the one line that changed', () => {
    const { term, screen } = setup();
    screen.render(['a', 'b', 'c', 'd']);
    term.takeOutput();
    screen.render(['a', 'B', 'c', 'd']);
    const output = term.takeOutput();
    expect(count(output, ERASE_LINE)).toBe(1);
    expect(output).toContain('B');
    expect(output).not.toMatch(/[acd]/);
    expect(term.history()).toEqual(['$ chimera', 'a', 'B', 'c', 'd']);
  });

  it('writes one row for a spinner tick in the bottom chrome', () => {
    const { term, screen } = setup(20, 5);
    const frame = (spinner: string) => [...lines('line', 12), `${spinner} working`, '> prompt'];
    screen.render(frame('⠋'));
    term.takeOutput();
    screen.render(frame('⠙'));
    const output = term.takeOutput();
    expect(count(output, ERASE_LINE)).toBe(1);
    expect(term.screen()).toEqual(['line9', 'line10', 'line11', '⠙ working', '> prompt']);
    expect(term.scrollback()).toHaveLength(10);
  });

  it('clears the rows left over when the content shrinks', () => {
    const { term, screen } = setup();
    screen.render(['a', 'b', 'c', 'd']);
    screen.render(['a', 'x']);
    expect(term.history()).toEqual(['$ chimera', 'a', 'x']);
    screen.render(['a', 'x', 'y']);
    expect(term.history()).toEqual(['$ chimera', 'a', 'x', 'y']);
  });

  it('keeps its place when lines are only taken away', () => {
    const { term, screen } = setup();
    screen.render(['a', 'b', 'c', 'd']);
    screen.render(['a', 'b']);
    expect(term.history()).toEqual(['$ chimera', 'a', 'b']);
    screen.render(['a', 'B', 'c']);
    expect(term.history()).toEqual(['$ chimera', 'a', 'B', 'c']);
    screen.render([]);
    screen.render(['z']);
    expect(term.history()).toEqual(['$ chimera', 'z']);
  });

  it('clears screen and scrollback and reprints when a line above the viewport changes', () => {
    const { term, screen } = setup(20, 4);
    const before = lines('row', 10);
    screen.render(before);
    term.takeOutput();
    const after = [...before];
    after[1] = 'ROW1';
    screen.render(after);
    const output = term.takeOutput();
    expect(output).toContain(CLEAR_ALL);
    expect(term.history()).toEqual(after);
    expect(new Set(term.history()).size).toBe(after.length);
  });

  it('clears screen and scrollback and reprints at the new width', () => {
    const { term, screen } = setup(20, 4);
    screen.render(lines('row', 8));
    term.resize(10, 4);
    term.takeOutput();
    screen.render(lines('row', 8));
    expect(term.takeOutput()).toContain(CLEAR_ALL);
    expect(term.history()).toEqual(lines('row', 8));
  });

  it('puts every frame inside synchronized output, and nothing outside it', () => {
    const { term, screen } = setup();
    const printedBefore = term.unsyncedPrints;
    screen.render(['a']);
    screen.render(['a', 'b']);
    screen.render(['c']);
    expect(term.syncFrames).toBe(3);
    expect(term.unsyncedPrints).toBe(printedBefore);
  });

  it('writes nothing for a frame that did not change', () => {
    const { term, screen } = setup();
    screen.render(['a', 'b']);
    term.takeOutput();
    screen.render(['a', 'b']);
    expect(term.takeOutput()).toBe('');
  });

  it('splits a large frame into several writes', () => {
    const writes: string[] = [];
    const out = { columns: 200, rows: 50, write: (chunk: string) => writes.push(chunk) };
    new InlineScreen(out).render(Array.from({ length: 2_000 }, () => 'x'.repeat(150)));
    expect(writes.length).toBeGreaterThan(1);
    expect(writes[0]!.startsWith('\x1b[?2026h')).toBe(true);
    expect(writes.at(-1)!.endsWith('\x1b[?2026l')).toBe(true);
  });

  it('clips a line wider than the terminal so it never wraps', () => {
    const { term, screen } = setup(5, 4);
    screen.render(['abcdefgh', 'next']);
    expect(term.history()).toEqual(['$ chi', 'mera', 'abcd…', 'next']);
  });

  it('can start over, as after a screen clear', () => {
    const { term, screen } = setup();
    screen.render(['a', 'b']);
    term.write(CLEAR_ALL);
    screen.reset();
    screen.render(['a', 'b']);
    expect(term.history()).toEqual(['a', 'b']);
  });
});

describe('AltScreen', () => {
  function setup(columns = 10, rows = 3) {
    const term = new VirtualTerminal({ columns, rows });
    term.write('shell text\r\n$ ');
    const screen = new AltScreen(term);
    return { term, screen };
  }

  it('enters the alternate screen with autowrap off and draws exactly height rows', () => {
    const { term, screen } = setup();
    screen.enter();
    expect(term.alternate).toBe(true);
    expect(term.modes.has(7)).toBe(false);
    screen.render(['a', 'b', 'c', 'd']);
    expect(term.screen()).toEqual(['a', 'b', 'c']);
    screen.render(['x']);
    expect(term.screen()).toEqual(['x', '', '']);
  });

  it('rewrites only the rows that changed, inside synchronized output', () => {
    const { term, screen } = setup();
    const printedBefore = term.unsyncedPrints;
    screen.enter();
    screen.render(['a', 'b', 'c']);
    term.takeOutput();
    screen.render(['a', 'B', 'c']);
    const output = term.takeOutput();
    expect(output).toContain('B');
    expect(output).not.toMatch(/[ac]/);
    expect(term.screen()).toEqual(['a', 'B', 'c']);
    expect(term.unsyncedPrints).toBe(printedBefore);
  });

  it('keeps the last cell of a full-width row', () => {
    const { term, screen } = setup(4, 2);
    screen.enter();
    screen.render(['abcd', 'efgh']);
    expect(term.screen()).toEqual(['abcd', 'efgh']);
  });

  it('redraws fully after a resize', () => {
    const { term, screen } = setup();
    screen.enter();
    screen.render(['a', 'b', 'c']);
    term.resize(8, 4);
    screen.invalidate();
    term.takeOutput();
    screen.render(['a', 'b', 'c', 'd']);
    const output = term.takeOutput();
    expect(output).toContain('a');
    expect(term.screen()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves the main screen as it was, with autowrap back on', () => {
    const { term, screen } = setup();
    const before = term.screen();
    screen.enter();
    screen.render(['tui', 'frame', 'here']);
    screen.leave();
    expect(term.alternate).toBe(false);
    expect(term.screen()).toEqual(before);
    expect(term.modes.has(7)).toBe(true);
    expect(term.modes.has(25)).toBe(true);
  });
});

describe('a row with controls in it', () => {
  const hostile = '\x1b[31mred\x1b[0m\x1b]52;c;eA==\x07\x1b[?1049l\x1b[H\r\x07 text';

  it.each([
    ['InlineScreen', (term: VirtualTerminal) => new InlineScreen(term)],
    [
      'AltScreen',
      (term: VirtualTerminal) => {
        const screen = new AltScreen(term);
        screen.enter();
        return screen;
      },
    ],
  ])('%s writes its colours and drops every other control', (_name, create) => {
    const term = new VirtualTerminal({ columns: 40, rows: 5 });
    const screen = create(term);
    term.takeOutput();
    screen.render([hostile]);
    const written = term.takeOutput();
    expect(written).toContain('\x1b[31mred\x1b[0m');
    expect(written).not.toContain('\x1b]52');
    expect(written).not.toContain('\x1b[?1049l');
    expect(written).not.toContain('\x07');
    expect(term.screen()[0]?.trimEnd()).toBe('red text');
  });
});
