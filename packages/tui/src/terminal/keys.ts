/**
 * Terminal input, split into one event per key in the order typed. Knows
 * legacy control and escape sequences, the Kitty keyboard protocol (CSI u),
 * xterm modifyOtherKeys, SGR mouse reports, focus reports and bracketed paste.
 */

export interface KeyEvent {
  type: 'key';
  /**
   * `enter`, `tab`, `escape`, `backspace`, `delete`, `insert`, `up`, `down`,
   * `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `f1`…`f12`, or the
   * character itself (`a`, `A`, `?`, ` `).
   */
  name: string;
  /** What the key types: set for a printable key pressed without Ctrl or Alt. */
  text?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The bytes the terminal sent. */
  sequence: string;
}

export interface PasteEvent {
  type: 'paste';
  /** The pasted text, with CRLF and lone CR turned into LF. */
  text: string;
}

export interface MouseEvent {
  type: 'mouse';
  action: 'press' | 'release' | 'drag' | 'move' | 'wheel-up' | 'wheel-down';
  /** 0 left, 1 middle, 2 right. */
  button: number;
  /** Zero-based cell. */
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface FocusEvent {
  type: 'focus';
  focused: boolean;
}

export type InputEvent = KeyEvent | PasteEvent | MouseEvent | FocusEvent;

const ESC = '\x1b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

const TILDE_KEYS: Record<number, string> = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12',
};

const LETTER_KEYS: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
  M: 'enter',
};

// Kitty's codes for keys that have no character of their own.
const KITTY_FUNCTIONAL: Record<number, string> = {
  57399: '0',
  57414: 'enter',
  57417: 'left',
  57418: 'right',
  57419: 'up',
  57420: 'down',
  57421: 'pageup',
  57422: 'pagedown',
  57423: 'home',
  57424: 'end',
  57425: 'insert',
  57426: 'delete',
};

function key(
  name: string,
  sequence: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
  text?: string,
): KeyEvent {
  return {
    type: 'key',
    name,
    ...(text !== undefined ? { text } : {}),
    ctrl: modifiers.ctrl ?? false,
    alt: modifiers.alt ?? false,
    shift: modifiers.shift ?? false,
    sequence,
  };
}

/** xterm's modifier parameter: 1 + a bitmask of Shift 1, Alt 2, Ctrl 4. */
function modifiersOf(parameter: number | undefined): {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
} {
  const bits = Math.max(0, (parameter ?? 1) - 1);
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

/** The key for a Unicode code point, as CSI u and modifyOtherKeys report it. */
function keyForCode(
  code: number,
  shiftedCode: number | undefined,
  modifierParameter: number | undefined,
  sequence: string,
): KeyEvent {
  const modifiers = modifiersOf(modifierParameter);
  if (KITTY_FUNCTIONAL[code]) return key(KITTY_FUNCTIONAL[code], sequence, modifiers);
  if (code === 13) return key('enter', sequence, modifiers);
  if (code === 9) return key('tab', sequence, modifiers);
  if (code === 27) return key('escape', sequence, modifiers);
  if (code === 127 || code === 8) return key('backspace', sequence, modifiers);
  let char = String.fromCodePoint(code);
  if (modifiers.shift && !modifiers.ctrl && !modifiers.alt) {
    char = shiftedCode !== undefined ? String.fromCodePoint(shiftedCode) : char.toUpperCase();
  }
  const types = !modifiers.ctrl && !modifiers.alt;
  return key(char, sequence, modifiers, types ? char : undefined);
}

/** One byte below 0x20, or DEL, as a key. */
function controlKey(char: string, sequence: string, alt: boolean): KeyEvent {
  const code = char.charCodeAt(0);
  if (char === '\r') return key('enter', sequence, { alt });
  // In raw mode Enter sends CR; LF comes from Ctrl+J, which the prompt reads as a newline.
  if (char === '\n') return key('enter', sequence, { alt, ctrl: true });
  if (char === '\t') return key('tab', sequence, { alt });
  if (char === '\x7f' || char === '\b') return key('backspace', sequence, { alt });
  if (char === ESC) return key('escape', sequence, { alt });
  if (code === 0) return key(' ', sequence, { ctrl: true, alt });
  if (code >= 1 && code <= 26)
    return key(String.fromCharCode(code + 96), sequence, { ctrl: true, alt });
  return key(String.fromCharCode(code + 64).toLowerCase(), sequence, { ctrl: true, alt });
}

const segmenter = new Intl.Segmenter();

export class KeyParser {
  private buffer = '';
  private paste: string | null = null;

  /** Bytes are held: a lone Esc, or the start of a sequence. `flush` decides them. */
  get pending(): boolean {
    return this.buffer.length > 0 && this.paste === null;
  }

  feed(chunk: string): InputEvent[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  /**
   * Treat what is held as complete: a lone Esc is the Escape key. Called
   * when no more bytes came within the escape timeout.
   */
  flush(): InputEvent[] {
    return this.drain(true);
  }

  private drain(final: boolean): InputEvent[] {
    const events: InputEvent[] = [];
    while (this.buffer.length > 0) {
      if (this.paste !== null) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end < 0) {
          // Keep what could be the start of the end marker for the next read.
          const keep = markerPrefix(this.buffer, PASTE_END);
          this.paste += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          return events;
        }
        this.paste += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + PASTE_END.length);
        events.push({ type: 'paste', text: this.paste.replace(/\r\n?/g, '\n') });
        this.paste = null;
        continue;
      }
      const consumed = this.next(events, final);
      if (consumed === 0) return events;
      this.buffer = this.buffer.slice(consumed);
    }
    return events;
  }

  /** Parse one event at the start of the buffer; 0 when it needs more bytes. */
  private next(events: InputEvent[], final: boolean): number {
    const input = this.buffer;
    const first = input[0]!;
    if (first !== ESC) {
      if (first.charCodeAt(0) < 0x20 || first === '\x7f') {
        events.push(controlKey(first, first, false));
        return 1;
      }
      const { value: grapheme } = segmenter.segment(input)[Symbol.iterator]().next();
      const text = (grapheme as { segment: string }).segment;
      // Printable text ends where a control byte or an escape starts.
      events.push(key(text, text, {}, text));
      return text.length;
    }
    if (input.length === 1) {
      if (!final) return 0;
      events.push(key('escape', ESC));
      return 1;
    }
    const second = input[1]!;
    if (second === '[') return this.csi(events, final);
    if (second === 'O') {
      if (input.length < 3) {
        if (!final) return 0;
        events.push(key('O', `${ESC}O`, { alt: true }));
        return 2;
      }
      const name = LETTER_KEYS[input[2]!];
      if (name) events.push(key(name, input.slice(0, 3)));
      return 3;
    }
    if (second === ESC) {
      events.push(key('escape', ESC));
      return 1;
    }
    const sequence = input.slice(0, 2);
    if (second.charCodeAt(0) < 0x20 || second === '\x7f') {
      events.push(controlKey(second, sequence, true));
      return 2;
    }
    events.push(key(second, sequence, { alt: true }));
    return 2;
  }

  private csi(events: InputEvent[], final: boolean): number {
    const input = this.buffer;
    if (input.startsWith(PASTE_START)) {
      this.paste = '';
      return PASTE_START.length;
    }
    let end = 2;
    while (end < input.length) {
      const code = input.charCodeAt(end);
      if (code >= 0x40 && code <= 0x7e) break;
      end += 1;
    }
    if (end >= input.length) {
      if (!final) return 0;
      events.push(key('[', `${ESC}[`, { alt: true }));
      return 2;
    }
    const sequence = input.slice(0, end + 1);
    const body = input.slice(2, end);
    const terminator = input[end]!;
    const event = parseCsi(body, terminator, sequence);
    if (event) events.push(event);
    return end + 1;
  }
}

function parseCsi(body: string, terminator: string, sequence: string): InputEvent | null {
  if (body.startsWith('<') && (terminator === 'M' || terminator === 'm')) {
    return parseSgrMouse(body.slice(1), terminator === 'M');
  }
  if (body === '' && (terminator === 'I' || terminator === 'O')) {
    return { type: 'focus', focused: terminator === 'I' };
  }
  if (/^[?>=]/.test(body)) return null;
  const params = body.split(';');
  const numbers = params.map((part) => Number.parseInt(part, 10));
  if (terminator === 'Z') return key('tab', sequence, { shift: true });
  if (terminator === 'u') {
    const [codePart = '', shiftedPart] = (params[0] ?? '').split(':');
    const code = Number.parseInt(codePart, 10);
    if (Number.isNaN(code)) return null;
    const shifted = shiftedPart ? Number.parseInt(shiftedPart, 10) : undefined;
    const [modifierPart = '1', eventPart = '1'] = (params[1] ?? '1').split(':');
    // Key releases arrive only when asked for; ignore them if a terminal sends one anyway.
    if (eventPart === '3') return null;
    return keyForCode(
      code,
      Number.isNaN(shifted) ? undefined : shifted,
      Number.parseInt(modifierPart, 10),
      sequence,
    );
  }
  if (terminator === '~') {
    if (numbers[0] === 27 && numbers.length >= 3) {
      return keyForCode(numbers[2]!, undefined, numbers[1], sequence);
    }
    const name = TILDE_KEYS[numbers[0]!];
    return name ? key(name, sequence, modifiersOf(numbers[1])) : null;
  }
  const name = LETTER_KEYS[terminator];
  if (name && name !== 'enter') return key(name, sequence, modifiersOf(numbers[1]));
  return null;
}

const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const MOTION_BIT = 32;
const MODIFIER_BITS = 4 | 8 | 16;

function parseSgrMouse(body: string, pressed: boolean): MouseEvent | null {
  const [codePart, columnPart, rowPart] = body.split(';');
  const code = Number(codePart);
  const x = Number(columnPart) - 1;
  const y = Number(rowPart) - 1;
  if ([code, x, y].some(Number.isNaN)) return null;
  const modifiers = { shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0 };
  const base = code & ~MODIFIER_BITS;
  const point = { x, y, ...modifiers };
  if (base === WHEEL_UP) return { type: 'mouse', action: 'wheel-up', button: 0, ...point };
  if (base === WHEEL_DOWN) return { type: 'mouse', action: 'wheel-down', button: 0, ...point };
  const button = base & 3;
  if ((base & MOTION_BIT) !== 0) {
    return { type: 'mouse', action: button === 3 ? 'move' : 'drag', button, ...point };
  }
  return { type: 'mouse', action: pressed ? 'press' : 'release', button, ...point };
}

function markerPrefix(input: string, marker: string): number {
  for (let length = Math.min(marker.length - 1, input.length); length > 0; length -= 1) {
    if (input.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}
