import { describe, expect, it } from 'vitest';
import {
  type Region,
  ScreenSelection,
  screenCells,
  selectedRows,
  selectedText,
} from '../src/input/screen-selection';

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

describe('selectedText', () => {
  const frame = [
    '  › add a flag to list          │ panel',
    '',
    '  ◆ Use this:                   │ model',
    '      const rows = 1;           │ gpt',
    '      if (rows) {               │',
    '        go();                   │',
    '      }                         │',
  ];

  it('reads the cells of one row', () => {
    const text = selectedText(frame, { anchor: { x: 4, y: 0 }, focus: { x: 13, y: 0 } }, region);
    expect(text).toBe('add a flag');
  });

  it('never takes text from outside the region', () => {
    const text = selectedText(frame, { anchor: { x: 4, y: 0 }, focus: { x: 60, y: 0 } }, region);
    expect(text).toBe('add a flag to list');
  });

  it('joins rows with line breaks and drops the padding at the end of each', () => {
    const text = selectedText(frame, { anchor: { x: 4, y: 0 }, focus: { x: 11, y: 2 } }, region);
    expect(text).toBe('add a flag to list\n\n◆ Use this');
  });

  it('keeps the shape of code: later rows lose the indent the first row starts at', () => {
    const text = selectedText(frame, { anchor: { x: 6, y: 3 }, focus: { x: 6, y: 6 } }, region);
    expect(text).toBe('const rows = 1;\nif (rows) {\n  go();\n}');
  });

  it('reads one cell for a selection of one cell', () => {
    expect(selectedText(frame, { anchor: { x: 4, y: 0 }, focus: { x: 4, y: 0 } }, region)).toBe(
      'a',
    );
  });

  it('takes a wide character whole when the selection ends inside it', () => {
    const wide = ['  日本語 text'];
    const text = selectedText(wide, { anchor: { x: 3, y: 0 }, focus: { x: 4, y: 0 } }, region);
    expect(text).toBe('日本');
  });
});

describe('ScreenSelection', () => {
  const frame = ['  hello world       ', '  second line      ', '  third            '].join('\n');
  const wholeScreen = () => ({ left: 0, right: 19 });

  function selection() {
    const written: string[] = [];
    const screen = new ScreenSelection({
      write: (text) => written.push(text),
      regionAt: wholeScreen,
      highlight: (text) => `<${text}>`,
    });
    screen.frame(frame);
    return { screen, written };
  }

  it('paints the highlight as the user drags, at the cells under the pointer', () => {
    const { screen, written } = selection();

    screen.press(2, 0);
    screen.drag(6, 0);

    expect(written.at(-1)).toContain(`${ESC}[1;3H<hello>`);
  });

  it('gives the text when the button is released', () => {
    const { screen } = selection();
    screen.press(2, 0);
    screen.drag(7, 1);

    expect(screen.release()).toBe('hello world\nsecond');
  });

  it('gives nothing for a plain click, so a click does not replace the clipboard', () => {
    const { screen } = selection();
    screen.press(4, 1);

    expect(screen.release()).toBeNull();
  });

  it('puts the rows back as they were when the selection is cleared', () => {
    const { screen, written } = selection();
    screen.press(2, 0);
    screen.drag(6, 0);
    written.length = 0;

    screen.clear();

    expect(written.join('')).toContain(`${ESC}[1;1H  hello world       `);
    expect(written.join('')).not.toContain('<');
  });

  it('paints the highlight again after the app redraws the screen', () => {
    const { screen, written } = selection();
    screen.press(2, 1);
    screen.drag(7, 1);
    written.length = 0;

    screen.frame(frame.replace('third', 'THIRD'));

    expect(written.join('')).toContain(`${ESC}[2;3H<second>`);
  });

  it('un-paints the cells the selection no longer covers when it shrinks', () => {
    const { screen, written } = selection();
    screen.press(2, 0);
    screen.drag(7, 1);
    written.length = 0;

    screen.drag(6, 0);

    const output = written.join('');
    expect(output).toContain(`${ESC}[2;1H  second line      `);
    expect(output).toContain(`${ESC}[1;3H<hello>`);
  });
});
