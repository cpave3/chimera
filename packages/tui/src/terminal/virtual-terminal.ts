import { EventEmitter } from 'node:events';
import { graphemes } from './width';

/** The SGR state of one cell; a key is present only once a sequence set it. */
export interface CellStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

interface Cell {
  /** Empty for the second cell of a wide character. */
  char: string;
  style: CellStyle;
}

type Row = Cell[];

interface Buffer {
  rows: Row[];
  cursor: { x: number; y: number };
  pendingWrap: boolean;
  savedCursor: { x: number; y: number; pendingWrap: boolean } | null;
}

const ESC = '\x1b';

/**
 * A fake TTY for tests: it takes what the screen writers send, replays the
 * escape codes into a grid of cells and a scrollback, and can be resized.
 * It knows the sequences Chimera writes, and behaves as xterm and tmux do
 * for them. A bare LF moves down without returning, as on a TTY in raw mode.
 */
export class VirtualTerminal extends EventEmitter {
  readonly isTTY: boolean;
  columns: number;
  rows: number;
  /** Private modes (`CSI ? n h`) that are on; autowrap (7) starts on. */
  readonly modes = new Set<number>([7, 25]);
  /** The Kitty keyboard flags pushed with `CSI > n u` and not yet popped. */
  readonly kittyFlags: number[] = [];
  /** The xterm modifyOtherKeys level set with `CSI > 4 ; n m`. */
  modifyOtherKeys = 0;
  /** The body of every OSC sequence, in order. */
  readonly osc: string[] = [];
  bells = 0;
  /** Frames opened and closed with `CSI ? 2026 h … l`. */
  syncFrames = 0;
  /** Printable characters written while no synchronized frame was open. */
  unsyncedPrints = 0;

  private main: Buffer;
  private alt: Buffer | null = null;
  private scrolledOff: Row[] = [];
  private style: CellStyle = {};
  private pending = '';
  private recent = '';
  /** Everything written since the terminal was made. */
  output = '';

  constructor(
    size: { columns: number; rows: number; isTTY?: boolean } = { columns: 80, rows: 24 },
  ) {
    super();
    this.isTTY = size.isTTY ?? true;
    this.columns = size.columns;
    this.rows = size.rows;
    this.main = this.newBuffer();
  }

  get alternate(): boolean {
    return this.alt !== null;
  }

  get cursor(): { x: number; y: number } {
    return { ...this.buffer.cursor };
  }

  private get buffer(): Buffer {
    return this.alt ?? this.main;
  }

  private newBuffer(): Buffer {
    return {
      rows: Array.from({ length: this.rows }, () => this.blankRow()),
      cursor: { x: 0, y: 0 },
      pendingWrap: false,
      savedCursor: null,
    };
  }

  private blankRow(): Row {
    return Array.from({ length: this.columns }, () => ({ char: ' ', style: {} }));
  }

  write(data: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown): boolean {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    this.output += text;
    this.recent += text;
    this.feed(this.pending + text);
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (typeof done === 'function') (done as () => void)();
    return true;
  }

  /** What was written since the last call. */
  takeOutput(): string {
    const recent = this.recent;
    this.recent = '';
    return recent;
  }

  resize(columns: number, rows: number): void {
    for (const buffer of [this.main, this.alt]) {
      if (!buffer) continue;
      if (rows < this.rows) {
        const excess = Math.max(0, buffer.cursor.y - (rows - 1));
        const removed = buffer.rows.splice(0, excess);
        if (buffer === this.main) this.scrolledOff.push(...removed);
        buffer.rows.length = rows;
        buffer.cursor.y -= excess;
      } else {
        while (buffer.rows.length < rows) buffer.rows.push([]);
      }
      buffer.rows = buffer.rows.map((row) => {
        const resized = row.slice(0, columns);
        while (resized.length < columns) resized.push({ char: ' ', style: {} });
        return resized;
      });
      buffer.cursor.x = Math.min(buffer.cursor.x, columns - 1);
      buffer.pendingWrap = false;
    }
    this.scrolledOff = this.scrolledOff.map((row) => row.slice(0, columns));
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }

  /** The visible rows, with trailing blanks trimmed. */
  screen(): string[] {
    return this.buffer.rows.map(rowText);
  }

  /** Lines that scrolled off the top of the main screen, oldest first. */
  scrollback(): string[] {
    return this.scrolledOff.map(rowText);
  }

  /** Scrollback and main screen together, without blank rows at the end. */
  history(): string[] {
    const lines = [...this.scrolledOff, ...this.main.rows].map(rowText);
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    return lines;
  }

  styleAt(x: number, y: number): CellStyle {
    return { ...(this.buffer.rows[y]?.[x]?.style ?? {}) };
  }

  private feed(input: string): void {
    this.pending = '';
    let index = 0;
    while (index < input.length) {
      const char = input[index]!;
      if (char === ESC) {
        const consumed = this.escape(input, index);
        if (consumed === 0) {
          this.pending = input.slice(index);
          return;
        }
        index += consumed;
        continue;
      }
      const code = char.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) {
        this.control(char);
        index += 1;
        continue;
      }
      let end = index;
      while (end < input.length) {
        const next = input.charCodeAt(end);
        if (next < 0x20 || next === 0x7f) break;
        end += 1;
      }
      this.print(input.slice(index, end));
      index = end;
    }
  }

  private control(char: string): void {
    const buffer = this.buffer;
    if (char === '\r') {
      buffer.cursor.x = 0;
      buffer.pendingWrap = false;
    } else if (char === '\n') {
      this.lineFeed();
    } else if (char === '\b') {
      buffer.cursor.x = Math.max(0, buffer.cursor.x - 1);
      buffer.pendingWrap = false;
    } else if (char === '\t') {
      buffer.cursor.x = Math.min(this.columns - 1, (Math.floor(buffer.cursor.x / 8) + 1) * 8);
    } else if (char === '\x07') {
      this.bells += 1;
    }
  }

  private lineFeed(): void {
    const buffer = this.buffer;
    buffer.pendingWrap = false;
    if (buffer.cursor.y < this.rows - 1) {
      buffer.cursor.y += 1;
      return;
    }
    const top = buffer.rows.shift()!;
    if (buffer === this.main) this.scrolledOff.push(top);
    buffer.rows.push(this.blankRow());
  }

  private print(text: string): void {
    if (!this.modes.has(2026)) this.unsyncedPrints += text.length;
    const buffer = this.buffer;
    const autowrap = this.modes.has(7);
    for (const grapheme of graphemes(text)) {
      const width = grapheme.width;
      if (width === 0) {
        const previous = buffer.rows[buffer.cursor.y]![Math.max(0, buffer.cursor.x - 1)];
        if (previous) previous.char += grapheme.text;
        continue;
      }
      if (buffer.pendingWrap && autowrap) {
        buffer.cursor.x = 0;
        this.lineFeed();
      }
      if (buffer.cursor.x + width > this.columns) {
        if (autowrap) {
          buffer.cursor.x = 0;
          this.lineFeed();
        } else {
          buffer.cursor.x = this.columns - width;
        }
      }
      const row = buffer.rows[buffer.cursor.y]!;
      row[buffer.cursor.x] = { char: grapheme.text, style: { ...this.style } };
      if (width === 2) row[buffer.cursor.x + 1] = { char: '', style: { ...this.style } };
      if (buffer.cursor.x + width >= this.columns) {
        buffer.cursor.x = this.columns - 1;
        buffer.pendingWrap = autowrap;
      } else {
        buffer.cursor.x += width;
        buffer.pendingWrap = false;
      }
    }
  }

  /** Handle the escape sequence at `start`; 0 when it is not complete yet. */
  private escape(input: string, start: number): number {
    const next = input[start + 1];
    if (next === undefined) return 0;
    if (next === '[') {
      let end = start + 2;
      while (end < input.length) {
        const code = input.charCodeAt(end);
        if (code >= 0x40 && code <= 0x7e) break;
        end += 1;
      }
      if (end >= input.length) return 0;
      this.csi(input.slice(start + 2, end), input[end]!);
      return end - start + 1;
    }
    if (next === ']') {
      const bell = input.indexOf('\x07', start);
      const terminator = input.indexOf(`${ESC}\\`, start);
      const candidates = [bell, terminator].filter((position) => position >= 0);
      if (candidates.length === 0) return 0;
      const end = Math.min(...candidates);
      this.osc.push(input.slice(start + 2, end));
      return end - start + (end === bell ? 1 : 2);
    }
    if (next === '7') {
      const buffer = this.buffer;
      buffer.savedCursor = { ...buffer.cursor, pendingWrap: buffer.pendingWrap };
    } else if (next === '8') {
      this.restoreCursor();
    }
    return 2;
  }

  private restoreCursor(): void {
    const buffer = this.buffer;
    if (!buffer.savedCursor) return;
    buffer.cursor = { x: buffer.savedCursor.x, y: buffer.savedCursor.y };
    buffer.pendingWrap = buffer.savedCursor.pendingWrap;
  }

  private csi(body: string, final: string): void {
    const prefix = /^[?<>=]/.test(body) ? body[0] : '';
    const params = (prefix ? body.slice(1) : body).split(';').map((part) => {
      const value = Number.parseInt(part, 10);
      return Number.isNaN(value) ? undefined : value;
    });
    const first = params[0];
    const count = Math.max(1, first ?? 1);
    const buffer = this.buffer;
    const cursor = buffer.cursor;
    const clampY = (y: number) => Math.max(0, Math.min(this.rows - 1, y));
    const clampX = (x: number) => Math.max(0, Math.min(this.columns - 1, x));
    if (prefix === '?') {
      if (final === 'h' || final === 'l') {
        for (const mode of params) if (mode !== undefined) this.privateMode(mode, final === 'h');
      }
      return;
    }
    if (prefix === '>') {
      if (final === 'u') this.kittyFlags.push(first ?? 0);
      else if (final === 'm' && first === 4) this.modifyOtherKeys = params[1] ?? 0;
      return;
    }
    if (prefix === '<') {
      if (final === 'u') this.kittyFlags.splice(-Math.max(1, first ?? 1));
      return;
    }
    if (prefix === '=') return;
    if (final !== 'm') buffer.pendingWrap = false;
    switch (final) {
      case 'A':
        cursor.y = clampY(cursor.y - count);
        break;
      case 'B':
        cursor.y = clampY(cursor.y + count);
        break;
      case 'C':
        cursor.x = clampX(cursor.x + count);
        break;
      case 'D':
        cursor.x = clampX(cursor.x - count);
        break;
      case 'E':
        cursor.y = clampY(cursor.y + count);
        cursor.x = 0;
        break;
      case 'F':
        cursor.y = clampY(cursor.y - count);
        cursor.x = 0;
        break;
      case 'G':
        cursor.x = clampX(count - 1);
        break;
      case 'd':
        cursor.y = clampY(count - 1);
        break;
      case 'H':
      case 'f':
        cursor.y = clampY((first ?? 1) - 1);
        cursor.x = clampX((params[1] ?? 1) - 1);
        break;
      case 'J':
        this.eraseDisplay(first ?? 0);
        break;
      case 'K':
        this.eraseLine(first ?? 0);
        break;
      case 'm':
        this.sgr(params);
        break;
      case 's':
        buffer.savedCursor = { ...cursor, pendingWrap: buffer.pendingWrap };
        break;
      case 'u':
        this.restoreCursor();
        break;
    }
  }

  private privateMode(mode: number, on: boolean): void {
    if (mode === 1049 || mode === 1047 || mode === 47) {
      if (on && !this.alt) {
        this.main.savedCursor = { ...this.main.cursor, pendingWrap: this.main.pendingWrap };
        this.alt = this.newBuffer();
      } else if (!on && this.alt) {
        this.alt = null;
        this.restoreCursor();
      }
      return;
    }
    if (mode === 2026) {
      if (on && !this.modes.has(2026)) this.syncFrames += 1;
    }
    if (on) this.modes.add(mode);
    else this.modes.delete(mode);
  }

  private eraseLine(kind: number): void {
    const buffer = this.buffer;
    const row = buffer.rows[buffer.cursor.y]!;
    const [from, to] =
      kind === 0
        ? [buffer.cursor.x, this.columns]
        : kind === 1
          ? [0, buffer.cursor.x + 1]
          : [0, this.columns];
    for (let x = from; x < to; x += 1) row[x] = { char: ' ', style: {} };
  }

  private eraseDisplay(kind: number): void {
    const buffer = this.buffer;
    if (kind === 3) {
      this.scrolledOff = [];
      return;
    }
    if (kind === 2) {
      buffer.rows = buffer.rows.map(() => this.blankRow());
      return;
    }
    if (kind === 0) {
      this.eraseLine(0);
      for (let y = buffer.cursor.y + 1; y < this.rows; y += 1) buffer.rows[y] = this.blankRow();
    } else if (kind === 1) {
      this.eraseLine(1);
      for (let y = 0; y < buffer.cursor.y; y += 1) buffer.rows[y] = this.blankRow();
    }
  }

  private sgr(params: Array<number | undefined>): void {
    if (params.length === 0) params = [0];
    for (let index = 0; index < params.length; index += 1) {
      const code = params[index] ?? 0;
      if (code === 0) this.style = {};
      else if (code === 1) this.style.bold = true;
      else if (code === 2) this.style.dim = true;
      else if (code === 3) this.style.italic = true;
      else if (code === 4) this.style.underline = true;
      else if (code === 7) this.style.inverse = true;
      else if (code === 22) {
        this.style.bold = false;
        this.style.dim = false;
      } else if (code === 23) this.style.italic = false;
      else if (code === 24) this.style.underline = false;
      else if (code === 27) this.style.inverse = false;
      else if (code === 39) this.style.fg = undefined;
      else if (code === 49) this.style.bg = undefined;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))
        this.style.fg = String(code);
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        this.style.bg = String(code);
      } else if (code === 38 || code === 48) {
        const mode = params[index + 1];
        const take = mode === 2 ? 5 : mode === 5 ? 3 : 1;
        const value = params.slice(index, index + take).join(';');
        if (code === 38) this.style.fg = value;
        else this.style.bg = value;
        index += take - 1;
      }
    }
  }
}

function rowText(row: Row): string {
  return row
    .map((cell) => cell.char)
    .join('')
    .trimEnd();
}

/**
 * A fake TTY input for tests: `send` delivers bytes as one read, the way a
 * terminal hands a burst of keys to the process.
 */
export class VirtualInput extends EventEmitter {
  readonly isTTY = true;
  isRaw = false;
  private paused = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  read(): null {
    return null;
  }
  get isPaused(): boolean {
    return this.paused;
  }
  send(bytes: string): void {
    this.emit('data', bytes);
  }
}
