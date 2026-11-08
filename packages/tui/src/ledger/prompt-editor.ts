import {
  endsWithUnescapedBackslashAtCursor,
  insertNewline,
  insertText,
  type MultilineBuffer,
  moveDown,
  moveLineEnd,
  moveLineStart,
  moveUp,
} from '../input/buffer';
import { type PasteRegistry, shouldCompactPaste } from '../input/paste';
import type { InputEvent } from '../terminal/keys';

export type EditOutcome =
  | { kind: 'submit'; text: string }
  | { kind: 'handled' }
  | { kind: 'unhandled' };

const segmenter = new Intl.Segmenter();

/** Offsets where graphemes of `text` start, and its end. */
function boundaries(text: string): number[] {
  const offsets = Array.from(segmenter.segment(text), (segment) => segment.index);
  offsets.push(text.length);
  return offsets;
}

/**
 * The text in the prompt box and the keys that edit it: typing, newlines,
 * moving by grapheme and by line, deleting, history and pastes. Keys it
 * has no use for are left to the caller (Tab, Esc, Ctrl+C, the menus).
 */
export class PromptEditor {
  buffer: MultilineBuffer = { text: '', cursor: 0 };
  private stickyColumn: number | null = null;
  private readonly history: string[] = [];
  private historyIndex = 0;

  constructor(private readonly pastes?: PasteRegistry) {}

  setText(text: string): void {
    this.set({ text, cursor: text.length });
  }

  setBuffer(buffer: MultilineBuffer): void {
    this.set(buffer);
  }

  insert(text: string): void {
    this.set(insertText(this.buffer, text));
  }

  private set(buffer: MultilineBuffer, keepColumn = false): void {
    this.buffer = buffer;
    if (!keepColumn) this.stickyColumn = null;
  }

  /** Put a message in the history, as Enter does. */
  remember(text: string): void {
    this.history.push(text);
    this.historyIndex = this.history.length;
  }

  handle(event: InputEvent): EditOutcome {
    if (event.type === 'paste') {
      const text =
        this.pastes && shouldCompactPaste(event.text)
          ? this.pastes.register(event.text)
          : event.text;
      this.insert(text);
      return { kind: 'handled' };
    }
    if (event.type !== 'key') return { kind: 'unhandled' };
    const { text, cursor } = this.buffer;
    switch (event.name) {
      case 'enter': {
        if (
          event.shift ||
          event.alt ||
          event.ctrl ||
          endsWithUnescapedBackslashAtCursor(this.buffer)
        ) {
          this.set(insertNewline(this.buffer));
          return { kind: 'handled' };
        }
        if (text.trim() === '') return { kind: 'handled' };
        this.remember(text);
        this.setText('');
        return { kind: 'submit', text };
      }
      case 'backspace': {
        if (cursor === 0) return { kind: 'handled' };
        const start = this.previousBoundary(event.ctrl || event.alt ? 'word' : 'grapheme');
        this.set({ text: text.slice(0, start) + text.slice(cursor), cursor: start });
        return { kind: 'handled' };
      }
      case 'delete': {
        const end = boundaries(text).find((offset) => offset > cursor) ?? cursor;
        this.set({ text: text.slice(0, cursor) + text.slice(end), cursor });
        return { kind: 'handled' };
      }
      case 'left':
        this.set({
          text,
          cursor: this.previousBoundary(event.ctrl || event.alt ? 'word' : 'grapheme'),
        });
        return { kind: 'handled' };
      case 'right': {
        if (event.ctrl || event.alt) {
          const match = /\s*\S+/.exec(text.slice(cursor));
          this.set({ text, cursor: cursor + (match ? match[0].length : 0) });
        } else {
          this.set({ text, cursor: boundaries(text).find((offset) => offset > cursor) ?? cursor });
        }
        return { kind: 'handled' };
      }
      case 'home':
        this.set(event.ctrl ? { text, cursor: 0 } : moveLineStart(this.buffer));
        return { kind: 'handled' };
      case 'end':
        this.set(event.ctrl ? { text, cursor: text.length } : moveLineEnd(this.buffer));
        return { kind: 'handled' };
      case 'up': {
        if (text === '' || (this.browsingHistory() && !text.slice(0, cursor).includes('\n'))) {
          return this.recall(-1);
        }
        const { buf, col } = moveUp(this.buffer, this.stickyColumn);
        this.set(buf, true);
        this.stickyColumn = col;
        return { kind: 'handled' };
      }
      case 'down': {
        if (text === '' || (this.browsingHistory() && !text.slice(cursor).includes('\n'))) {
          return this.recall(1);
        }
        const { buf, col } = moveDown(this.buffer, this.stickyColumn);
        this.set(buf, true);
        this.stickyColumn = col;
        return { kind: 'handled' };
      }
    }
    if (event.ctrl && !event.alt) {
      if (event.name === 'a') this.set(moveLineStart(this.buffer));
      else if (event.name === 'e') this.set(moveLineEnd(this.buffer));
      else if (event.name === 'u') {
        const start = moveLineStart(this.buffer).cursor;
        this.set({ text: text.slice(0, start) + text.slice(cursor), cursor: start });
      } else if (event.name === 'k') {
        const end = moveLineEnd(this.buffer).cursor;
        this.set({ text: text.slice(0, cursor) + text.slice(end), cursor });
      } else if (event.name === 'w') {
        const start = this.previousBoundary('word');
        this.set({ text: text.slice(0, start) + text.slice(cursor), cursor: start });
      } else return { kind: 'unhandled' };
      return { kind: 'handled' };
    }
    if (event.text !== undefined) {
      this.insert(event.text);
      return { kind: 'handled' };
    }
    return { kind: 'unhandled' };
  }

  private previousBoundary(unit: 'grapheme' | 'word'): number {
    const { text, cursor } = this.buffer;
    if (unit === 'word') {
      const match = /\S+\s*$/.exec(text.slice(0, cursor));
      return match
        ? cursor - match[0].length
        : Math.max(
            0,
            cursor - (text.slice(0, cursor).length - text.slice(0, cursor).trimEnd().length),
          );
    }
    let previous = 0;
    for (const offset of boundaries(text)) {
      if (offset >= cursor) break;
      previous = offset;
    }
    return previous;
  }

  /** The box holds a message recalled from history, unedited. */
  private browsingHistory(): boolean {
    return (
      this.historyIndex < this.history.length &&
      this.buffer.text === this.history[this.historyIndex]
    );
  }

  private recall(direction: -1 | 1): EditOutcome {
    if (this.history.length === 0) return { kind: 'handled' };
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
    this.setText(this.history[this.historyIndex] ?? '');
    return { kind: 'handled' };
  }
}
