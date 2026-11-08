import { describe, expect, it } from 'vitest';
import { type Region, screenCells, selectedRows } from '../src/input/screen-selection';

const ESC = '\x1b';
const region: Region = { left: 2, right: 30 };

describe('screenCells', () => {
  it('gives one cell for each column, without the colour codes', () => {
    const cells = screenCells(`${ESC}[38;2;1;2;3m› ${ESC}[39mhi${ESC}[0m`);
    expect(cells).toEqual(['›', ' ', 'h', 'i']);
  });

  it('gives a wide character two cells, the second one empty', () => {
    expect(screenCells('a日b')).toEqual(['a', '日', '', 'b']);
    expect(screenCells('ok ✅ done').slice(3, 6)).toEqual(['✅', '', ' ']);
  });

  it('keeps a combining mark with its letter', () => {
    expect(screenCells('éx')).toEqual(['é', 'x']);
  });
});

describe('selectedRows', () => {
  it('is one span on a single row, whichever way the user dragged', () => {
    const forward = selectedRows({ anchor: { x: 5, y: 3 }, focus: { x: 9, y: 3 } }, region);
    const backward = selectedRows({ anchor: { x: 9, y: 3 }, focus: { x: 5, y: 3 } }, region);

    expect(forward).toEqual([{ row: 3, from: 5, to: 10 }]);
    expect(backward).toEqual(forward);
  });

  it('runs to the edge of the region on every row but the last', () => {
    const rows = selectedRows({ anchor: { x: 10, y: 1 }, focus: { x: 6, y: 3 } }, region);

    expect(rows).toEqual([
      { row: 1, from: 10, to: 30 },
      { row: 2, from: 2, to: 30 },
      { row: 3, from: 2, to: 7 },
    ]);
  });

  it('stays inside the region when the pointer leaves it', () => {
    const rows = selectedRows({ anchor: { x: 5, y: 2 }, focus: { x: 80, y: 2 } }, region);
    expect(rows).toEqual([{ row: 2, from: 5, to: 30 }]);
  });
});
