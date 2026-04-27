import { describe, expect, it } from 'vitest';
import {
  backspace,
  cursorLineCol,
  deleteForward,
  endsWithUnescapedBackslashAtCursor,
  insertChar,
  insertNewline,
  insertText,
  lines,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUp,
  replaceAll,
  type MultilineBuffer,
} from '../src/input/buffer';

const empty = (): MultilineBuffer => ({ text: '', cursor: 0 });

describe('buffer: insertion', () => {
  it('insertChar at start, middle, and end', () => {
    expect(insertChar(empty(), 'a')).toEqual({ text: 'a', cursor: 1 });
    expect(insertChar({ text: 'ac', cursor: 1 }, 'b')).toEqual({ text: 'abc', cursor: 2 });
    expect(insertChar({ text: 'ab', cursor: 2 }, 'c')).toEqual({ text: 'abc', cursor: 3 });
  });

  it('insertText accepts multi-char strings', () => {
    expect(insertText({ text: 'xy', cursor: 1 }, 'AB')).toEqual({ text: 'xABy', cursor: 3 });
  });

  it('insertNewline splits a line at the cursor', () => {
    expect(insertNewline({ text: 'foobar', cursor: 3 })).toEqual({
      text: 'foo\nbar',
      cursor: 4,
    });
  });

  it('insertNewline replaces a trailing backslash with a newline', () => {
    expect(insertNewline({ text: 'hello\\', cursor: 6 })).toEqual({
      text: 'hello\n',
      cursor: 6,
    });
  });
});

describe('buffer: deletion', () => {
  it('backspace at offset 0 is a no-op', () => {
    expect(backspace({ text: 'abc', cursor: 0 })).toEqual({ text: 'abc', cursor: 0 });
  });

  it('backspace removes the char before the cursor', () => {
    expect(backspace({ text: 'abc', cursor: 2 })).toEqual({ text: 'ac', cursor: 1 });
  });

  it('backspace across a newline joins lines', () => {
    expect(backspace({ text: 'hello\nworld', cursor: 6 })).toEqual({
      text: 'helloworld',
      cursor: 5,
    });
  });

  it('deleteForward at end is a no-op', () => {
    expect(deleteForward({ text: 'abc', cursor: 3 })).toEqual({ text: 'abc', cursor: 3 });
  });

  it('deleteForward across a newline joins lines', () => {
    expect(deleteForward({ text: 'hello\nworld', cursor: 5 })).toEqual({
      text: 'helloworld',
      cursor: 5,
    });
  });
});

describe('buffer: horizontal motion', () => {
  it('moveLeft / moveRight cross line boundaries', () => {
    expect(moveLeft({ text: 'a\nb', cursor: 2 })).toEqual({ text: 'a\nb', cursor: 1 });
    expect(moveRight({ text: 'a\nb', cursor: 1 })).toEqual({ text: 'a\nb', cursor: 2 });
  });

  it('moveLeft at start is a no-op; moveRight at end is a no-op', () => {
    const buf = { text: 'abc', cursor: 0 };
    expect(moveLeft(buf)).toBe(buf);
    const buf2 = { text: 'abc', cursor: 3 };
    expect(moveRight(buf2)).toBe(buf2);
  });

  it('moveLineStart moves to the start of the current logical line', () => {
    expect(moveLineStart({ text: 'abc\ndef', cursor: 6 })).toEqual({
      text: 'abc\ndef',
      cursor: 4,
    });
    expect(moveLineStart({ text: 'abc', cursor: 2 })).toEqual({ text: 'abc', cursor: 0 });
  });

  it('moveLineEnd moves to the end of the current logical line', () => {
    expect(moveLineEnd({ text: 'abc\ndef', cursor: 4 })).toEqual({
      text: 'abc\ndef',
      cursor: 7,
    });
    expect(moveLineEnd({ text: 'abc\ndef', cursor: 1 })).toEqual({
      text: 'abc\ndef',
      cursor: 3,
    });
  });
});

describe('buffer: vertical motion with sticky column', () => {
  it('moveUp from line 1 to line 0 preserves desired column when possible', () => {
    const start: MultilineBuffer = { text: 'abcdef\nghijkl', cursor: 11 };
    const { buf, col } = moveUp(start, null);
    expect(buf.cursor).toBe(4);
    expect(col).toBe(4);
  });

  it('moveUp clamps to short line, but sticky column survives a return trip', () => {
    const start: MultilineBuffer = { text: 'short\nlonglonglong', cursor: 17 };
    const up = moveUp(start, null);
    expect(up.col).toBe(11);
    expect(up.buf.cursor).toBe(5);
    const back = moveDown(up.buf, up.col);
    expect(back.buf.cursor).toBe(17);
    expect(back.col).toBe(11);
  });

  it('moveDown at last line is a no-op', () => {
    const start: MultilineBuffer = { text: 'a\nb', cursor: 2 };
    const { buf } = moveDown(start, null);
    expect(buf).toBe(start);
  });

  it('moveUp at first line is a no-op', () => {
    const start: MultilineBuffer = { text: 'abc', cursor: 1 };
    const { buf } = moveUp(start, null);
    expect(buf).toBe(start);
  });
});

describe('buffer: helpers', () => {
  it('replaceAll resets cursor to text length', () => {
    expect(replaceAll({ text: 'old', cursor: 1 }, 'brand new text')).toEqual({
      text: 'brand new text',
      cursor: 14,
    });
  });

  it('cursorLineCol counts logical lines', () => {
    expect(cursorLineCol({ text: 'a\nbc\nd', cursor: 5 })).toEqual({ line: 2, col: 0 });
    expect(cursorLineCol({ text: 'a\nbc\nd', cursor: 3 })).toEqual({ line: 1, col: 1 });
  });

  it('lines splits on \\n', () => {
    expect(lines({ text: 'a\nb\nc', cursor: 0 })).toEqual(['a', 'b', 'c']);
    expect(lines({ text: '', cursor: 0 })).toEqual(['']);
  });

  it('endsWithUnescapedBackslashAtCursor', () => {
    expect(endsWithUnescapedBackslashAtCursor({ text: 'foo\\', cursor: 4 })).toBe(true);
    expect(endsWithUnescapedBackslashAtCursor({ text: 'foo\\bar', cursor: 4 })).toBe(true);
    expect(endsWithUnescapedBackslashAtCursor({ text: 'foo', cursor: 3 })).toBe(false);
    expect(endsWithUnescapedBackslashAtCursor({ text: '', cursor: 0 })).toBe(false);
  });
});
