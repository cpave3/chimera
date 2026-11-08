import { describe, expect, it } from 'vitest';
import {
  clipToWidth,
  displayWidth,
  padToWidth,
  sliceColumns,
  stripAnsi,
} from '../src/terminal/width';

const RED = '\x1b[31m';
const RESET = '\x1b[39m';

describe('displayWidth', () => {
  it('counts cells, not code units', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('👨‍👩‍👧')).toBe(2);
    expect(displayWidth('🇦🇺')).toBe(2);
    expect(displayWidth('é')).toBe(1);
    expect(displayWidth('é')).toBe(1);
  });

  it('ignores escape sequences', () => {
    expect(displayWidth(`${RED}red${RESET}`)).toBe(3);
  });
});

describe('clipToWidth', () => {
  it('leaves text that fits alone', () => {
    expect(clipToWidth('abc', 3)).toBe('abc');
  });

  it('cuts at the width and marks the cut', () => {
    expect(clipToWidth('abcdef', 4)).toBe('abc…');
    expect(clipToWidth('abcdef', 4, '')).toBe('abcd');
  });

  it('never splits a wide character, a ZWJ sequence, a flag or a combining mark', () => {
    expect(clipToWidth('日本語', 5, '')).toBe('日本');
    expect(clipToWidth('日本語', 5)).toBe('日本…');
    expect(clipToWidth('a👨‍👩‍👧b', 2, '')).toBe('a');
    expect(clipToWidth('a🇦🇺🇳🇿', 4, '')).toBe('a🇦🇺');
    expect(clipToWidth('xéy', 2, '')).toBe('xé');
  });

  it('keeps escape sequences and measures only text', () => {
    expect(clipToWidth(`${RED}abcdef${RESET}`, 3, '')).toBe(`${RED}abc${RESET}`);
  });
});

describe('padToWidth', () => {
  it('pads by display width', () => {
    expect(padToWidth('日本', 6)).toBe('日本  ');
    expect(padToWidth(`${RED}a${RESET}`, 3)).toBe(`${RED}a${RESET}  `);
  });
});

describe('sliceColumns', () => {
  it('takes the cells between two columns of plain text, keeping wide characters whole', () => {
    expect(sliceColumns('  hello world', 2, 7)).toBe('hello');
    expect(sliceColumns('日本語', 2, 4)).toBe('本');
    expect(sliceColumns(`${RED}abc${RESET}`, 1, 3)).toBe('bc');
  });
});

describe('stripAnsi', () => {
  it('removes CSI and OSC sequences', () => {
    expect(stripAnsi(`${RED}a${RESET}\x1b]8;;http://x\x07b\x1b]8;;\x07`)).toBe('ab');
  });
});
