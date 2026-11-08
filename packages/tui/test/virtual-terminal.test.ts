import { describe, expect, it, vi } from 'vitest';
import { VirtualTerminal } from '../src/terminal/virtual-terminal';

const ESC = '\x1b[';

describe('VirtualTerminal', () => {
  it('prints text, and CR LF starts the next line', () => {
    const term = new VirtualTerminal({ columns: 10, rows: 3 });
    term.write('ab\r\ncd');
    expect(term.screen()).toEqual(['ab', 'cd', '']);
    expect(term.cursor).toEqual({ x: 2, y: 1 });
  });

  it('moves down without returning on a bare LF, as a raw-mode TTY does', () => {
    const term = new VirtualTerminal({ columns: 10, rows: 3 });
    term.write('ab\ncd');
    expect(term.screen()).toEqual(['ab', '  cd', '']);
  });

  it('wraps at the right edge with autowrap on, and overwrites the last cell with it off', () => {
    const on = new VirtualTerminal({ columns: 4, rows: 3 });
    on.write('abcdef');
    expect(on.screen()).toEqual(['abcd', 'ef', '']);
    const off = new VirtualTerminal({ columns: 4, rows: 3 });
    off.write(`${ESC}?7labcdef`);
    expect(off.screen()).toEqual(['abcf', '', '']);
  });

  it('defers the wrap at the right edge until the next character', () => {
    const term = new VirtualTerminal({ columns: 4, rows: 3 });
    term.write('abcd\r\nx');
    expect(term.screen()).toEqual(['abcd', 'x', '']);
  });

  it('puts a wide character in two cells', () => {
    const term = new VirtualTerminal({ columns: 5, rows: 2 });
    term.write('a日b');
    expect(term.screen()).toEqual(['a日b', '']);
    expect(term.cursor.x).toBe(4);
    term.write('\r\n12345日');
    expect(term.scrollback()).toEqual(['a日b']);
    expect(term.screen()).toEqual(['12345', '日']);
  });

  it('scrolls the top line into scrollback on the main screen', () => {
    const term = new VirtualTerminal({ columns: 5, rows: 2 });
    term.write('1\r\n2\r\n3');
    expect(term.scrollback()).toEqual(['1']);
    expect(term.screen()).toEqual(['2', '3']);
    expect(term.history()).toEqual(['1', '2', '3']);
  });

  it('moves the cursor relatively and absolutely', () => {
    const term = new VirtualTerminal({ columns: 10, rows: 4 });
    term.write(`abc\r\ndef\r\nghi${ESC}2A${ESC}DX${ESC}3;5HY${ESC}1GZ${ESC}BW${ESC}2CV`);
    expect(term.screen()).toEqual(['abX', 'def', 'Zhi Y', ' W  V']);
  });

  it('erases parts of a line', () => {
    const term = new VirtualTerminal({ columns: 6, rows: 3 });
    term.write(`abcdef\r\nghijkl\r\nmnopqr${ESC}1;3H${ESC}K${ESC}2;3H${ESC}1K${ESC}3;3H${ESC}2K`);
    expect(term.screen()).toEqual(['ab', '   jkl', '']);
  });

  it('erases below, the whole screen, and the scrollback', () => {
    const term = new VirtualTerminal({ columns: 4, rows: 3 });
    term.write(`1\r\n2\r\n3\r\n4\r\n5${ESC}2;1H${ESC}J`);
    expect(term.screen()).toEqual(['3', '', '']);
    term.write(`${ESC}2J`);
    expect(term.screen()).toEqual(['', '', '']);
    expect(term.scrollback()).toEqual(['1', '2']);
    term.write(`${ESC}3J`);
    expect(term.scrollback()).toEqual([]);
  });

  it('keeps the main screen apart from the alternate screen', () => {
    const term = new VirtualTerminal({ columns: 6, rows: 3 });
    term.write('shell$');
    term.write(`${ESC}?1049h${ESC}Hfull${ESC}3;1Hscreen`);
    expect(term.alternate).toBe(true);
    expect(term.screen()).toEqual(['full', '', 'screen']);
    term.write(`\r\n\r\n`);
    expect(term.scrollback()).toEqual([]);
    term.write(`${ESC}?1049l`);
    expect(term.alternate).toBe(false);
    expect(term.screen()).toEqual(['shell$', '', '']);
    expect(term.cursor).toEqual({ x: 5, y: 0 });
  });

  it('records the style of each cell', () => {
    const term = new VirtualTerminal({ columns: 10, rows: 2 });
    term.write(`${ESC}1;35ma${ESC}39mb${ESC}22m${ESC}38;2;1;2;3m${ESC}48;5;22mc${ESC}0md`);
    expect(term.styleAt(0, 0)).toMatchObject({ bold: true, fg: '35' });
    expect(term.styleAt(1, 0)).toMatchObject({ bold: true, fg: undefined });
    expect(term.styleAt(2, 0)).toMatchObject({ bold: false, fg: '38;2;1;2;3', bg: '48;5;22' });
    expect(term.styleAt(3, 0)).toEqual({});
  });

  it('counts synchronized frames and printing outside them', () => {
    const term = new VirtualTerminal({ columns: 10, rows: 2 });
    term.write(`${ESC}?2026hab${ESC}?2026l`);
    expect(term.syncFrames).toBe(1);
    expect(term.unsyncedPrints).toBe(0);
    term.write('c');
    expect(term.unsyncedPrints).toBe(1);
  });

  it('tracks private modes, key reporting modes and OSC sequences', () => {
    const term = new VirtualTerminal({ columns: 10, rows: 2 });
    term.write(`${ESC}?2004h${ESC}?1002h${ESC}>1u${ESC}>4;1m\x1b]52;c;aGk=\x07`);
    expect(term.modes.has(2004)).toBe(true);
    expect(term.modes.has(1002)).toBe(true);
    expect(term.kittyFlags).toEqual([1]);
    expect(term.modifyOtherKeys).toBe(1);
    expect(term.osc).toEqual(['52;c;aGk=']);
    term.write(`${ESC}?1002l${ESC}<u${ESC}>4;0m`);
    expect(term.modes.has(1002)).toBe(false);
    expect(term.kittyFlags).toEqual([]);
    expect(term.modifyOtherKeys).toBe(0);
  });

  it('reassembles an escape sequence split across writes', () => {
    const term = new VirtualTerminal({ columns: 10, rows: 2 });
    term.write('a\x1b[');
    term.write('31mb');
    expect(term.screen()[0]).toBe('ab');
    expect(term.styleAt(1, 0)).toMatchObject({ fg: '31' });
  });

  it('resizes, keeping the cursor row in view, and tells listeners', () => {
    const term = new VirtualTerminal({ columns: 6, rows: 4 });
    const onResize = vi.fn();
    term.on('resize', onResize);
    term.write('1\r\n2\r\n3\r\nlonger');
    term.resize(3, 2);
    expect(onResize).toHaveBeenCalledOnce();
    expect([term.columns, term.rows]).toEqual([3, 2]);
    expect(term.scrollback()).toEqual(['1', '2']);
    expect(term.screen()).toEqual(['3', 'lon']);
  });

  it('gives back what was written since the last look', () => {
    const term = new VirtualTerminal({ columns: 10, rows: 2 });
    term.write('a');
    term.write('b');
    expect(term.takeOutput()).toBe('ab');
    expect(term.takeOutput()).toBe('');
  });
});
