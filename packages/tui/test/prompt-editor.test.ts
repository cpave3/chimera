import { describe, expect, it } from 'vitest';
import { PasteRegistry } from '../src/input/paste';
import { PromptEditor } from '../src/ledger/prompt-editor';
import { KeyParser } from '../src/terminal/keys';

function typeInto(editor: PromptEditor, ...chunks: string[]): string[] {
  const parser = new KeyParser();
  const submitted: string[] = [];
  for (const chunk of chunks) {
    for (const event of [...parser.feed(chunk), ...parser.flush()]) {
      const outcome = editor.handle(event);
      if (outcome.kind === 'submit') submitted.push(outcome.text);
    }
  }
  return submitted;
}

describe('PromptEditor', () => {
  it('submits on Enter and clears the box', () => {
    const editor = new PromptEditor();
    expect(typeInto(editor, 'hello\r')).toEqual(['hello']);
    expect(editor.buffer).toEqual({ text: '', cursor: 0 });
  });

  it('inserts a newline for Shift+Enter, Alt+Enter, Ctrl+J and a backslash before Enter', () => {
    const editor = new PromptEditor();
    typeInto(editor, 'a\x1b[13;2ub\x1b\rc\nd\\\re');
    expect(editor.buffer.text).toBe('a\nb\nc\nd\ne');
    expect(typeInto(editor, '\r')).toEqual(['a\nb\nc\nd\ne']);
  });

  it('moves through lines with the arrows, keeping the column', () => {
    const editor = new PromptEditor();
    typeInto(editor, 'abcdef\x1b[13;2uxy\x1b[A');
    expect(editor.buffer.cursor).toBe(2);
    typeInto(editor, 'Z');
    expect(editor.buffer.text).toBe('abZcdef\nxy');
    typeInto(editor, '\x1b[1;5H');
    typeInto(editor, '\x01!');
    expect(editor.buffer.text).toBe('!abZcdef\nxy');
  });

  it('edits by grapheme: Backspace takes a whole emoji, Delete the character after', () => {
    const editor = new PromptEditor();
    typeInto(editor, 'a😀b\x1b[D\x7f');
    expect(editor.buffer).toEqual({ text: 'ab', cursor: 1 });
    typeInto(editor, '\x1b[3~');
    expect(editor.buffer).toEqual({ text: 'a', cursor: 1 });
  });

  it('recalls history with Up and Down from an empty box', () => {
    const editor = new PromptEditor();
    typeInto(editor, 'first\r', 'second\r');
    typeInto(editor, '\x1b[A');
    expect(editor.buffer.text).toBe('second');
    typeInto(editor, '\x1b[A\x1b[A');
    expect(editor.buffer.text).toBe('first');
    typeInto(editor, '\x1b[B');
    expect(editor.buffer.text).toBe('second');
    typeInto(editor, '\x1b[B');
    expect(editor.buffer.text).toBe('');
  });

  it('turns a large paste into a marker that expands on submit, and keeps a small one as text', () => {
    const pastes = new PasteRegistry();
    const editor = new PromptEditor(pastes);
    const big = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\r\n');
    typeInto(editor, `see \x1b[200~${big}\x1b[201~`);
    expect(editor.buffer.text).toBe('see [Pasted text #1, 8 lines]');
    const [submitted] = typeInto(editor, '\r');
    expect(pastes.expand(submitted!)).toBe(`see ${big.replaceAll('\r\n', '\n')}`);
    typeInto(editor, '\x1b[200~two\rlines\x1b[201~');
    expect(editor.buffer.text).toBe('two\nlines');
  });

  it('does not submit an empty or blank box', () => {
    const editor = new PromptEditor();
    expect(typeInto(editor, '\r   \r')).toEqual([]);
  });

  it('leaves keys it does not edit with to the caller', () => {
    const editor = new PromptEditor();
    const [tab] = new KeyParser().feed('\t');
    expect(editor.handle(tab!)).toEqual({ kind: 'unhandled' });
  });
});
