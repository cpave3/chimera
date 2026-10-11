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

  it('drops clicks and releases without an event', () => {
    expect(extractMouseReports(`${ESC}[<0;3;4M${ESC}[<0;3;4m`)).toEqual({
      rest: '',
      events: [],
      focus: [],
      incomplete: '',
    });
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
