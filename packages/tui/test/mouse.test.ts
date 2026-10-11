import { describe, expect, it } from 'vitest';
import { extractMouseReports } from '../src/input/mouse';

const ESC = '\x1b';

describe('extractMouseReports', () => {
  it('takes a wheel report out of the input', () => {
    expect(extractMouseReports(`${ESC}[<64;10;5M`)).toEqual({
      rest: '',
      events: [{ kind: 'wheel-up' }],
      focus: [],
      incomplete: '',
    });
    expect(extractMouseReports(`${ESC}[<65;10;5M`).events).toEqual([{ kind: 'wheel-down' }]);
  });

  it('keeps the keys around a burst of reports', () => {
    const input = `a${ESC}[<64;1;1M${ESC}[<64;1;1Mb`;
    expect(extractMouseReports(input)).toEqual({
      rest: 'ab',
      events: [{ kind: 'wheel-up' }, { kind: 'wheel-up' }],
      focus: [],
      incomplete: '',
    });
  });

  it('reports the left button going down, moving and going up, with zero-based cells', () => {
    const input = `${ESC}[<0;3;4M${ESC}[<32;9;4M${ESC}[<0;9;4m`;
    expect(extractMouseReports(input).events).toEqual([
      { kind: 'press', x: 2, y: 3 },
      { kind: 'drag', x: 8, y: 3 },
      { kind: 'release', x: 8, y: 3 },
    ]);
  });

  it('ignores the other buttons and plain pointer motion', () => {
    const input = `${ESC}[<2;3;4M${ESC}[<2;3;4m${ESC}[<1;3;4M${ESC}[<35;5;5M`;
    expect(extractMouseReports(input)).toEqual({ rest: '', events: [], focus: [], incomplete: '' });
  });

  it('holds back a report that the chunk cut in two', () => {
    expect(extractMouseReports(`x${ESC}[<64;10`)).toEqual({
      rest: 'x',
      events: [],
      focus: [],
      incomplete: `${ESC}[<64;10`,
    });
  });

  it('leaves other escape sequences alone', () => {
    expect(extractMouseReports(`${ESC}[A`).rest).toBe(`${ESC}[A`);
    expect(extractMouseReports(`${ESC}OA`).rest).toBe(`${ESC}OA`);
  });

  it('takes focus reports out, in order', () => {
    expect(extractMouseReports(`${ESC}[Oab${ESC}[I`)).toEqual({
      rest: 'ab',
      events: [],
      focus: [false, true],
      incomplete: '',
    });
  });
});
