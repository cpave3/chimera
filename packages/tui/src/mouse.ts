import { PassThrough } from 'node:stream';

/**
 * Escape sequences to enable/disable mouse wheel reporting.
 *
 * `?1000h` enables basic X10 mouse reporting; `?1006h` switches to SGR
 * reporting which uses readable decimal arguments (so button numbers > 31 —
 * notably wheel up/down which are 64/65 — survive intact). We only care about
 * wheel events for scrollback paging; other mouse events are parsed and
 * discarded.
 */
export const ENABLE_MOUSE = '\x1b[?1006h\x1b[?1000h';
export const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1006l';

export type WheelDirection = 'up' | 'down';

/**
 * A stdin shim that intercepts SGR mouse escape sequences from the upstream
 * TTY source, emits wheel events via `onWheel`, and forwards all other input
 * bytes to Ink unchanged. Implements enough of `NodeJS.ReadStream` for Ink's
 * render() options to accept it — `isTTY`, `setRawMode`, `setEncoding`,
 * `pause`, `resume` delegate to the source.
 */
export class MouseAwareStdin extends PassThrough {
  readonly isTTY: boolean;
  private readonly source: NodeJS.ReadStream;
  private readonly onData: (chunk: Buffer | string) => void;
  private readonly wheelListeners = new Set<(dir: WheelDirection) => void>();

  constructor(source: NodeJS.ReadStream) {
    super();
    this.source = source;
    this.isTTY = Boolean(source.isTTY);
    this.onData = (chunk) => this.handleChunk(chunk);
    source.on('data', this.onData);
  }

  setRawMode(mode: boolean): this {
    this.source.setRawMode?.(mode);
    return this;
  }

  override setEncoding(encoding: BufferEncoding): this {
    this.source.setEncoding?.(encoding);
    return this;
  }

  override resume(): this {
    this.source.resume?.();
    super.resume();
    return this;
  }

  override pause(): this {
    this.source.pause?.();
    super.pause();
    return this;
  }

  /**
   * Ink calls `ref()` / `unref()` on stdin to keep the event loop alive while
   * it's reading input, then releases it on unmount. `PassThrough` doesn't
   * expose these (they live on TTY / Socket). Delegate to the source so ink's
   * lifetime management still works.
   */
  ref(): this {
    (this.source as { ref?: () => void }).ref?.();
    return this;
  }

  unref(): this {
    (this.source as { unref?: () => void }).unref?.();
    return this;
  }

  onWheel(handler: (dir: WheelDirection) => void): () => void {
    this.wheelListeners.add(handler);
    return () => {
      this.wheelListeners.delete(handler);
    };
  }

  close(): void {
    this.source.off('data', this.onData);
    this.wheelListeners.clear();
    this.end();
  }

  private handleChunk(chunk: Buffer | string): void {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const { cleaned, wheels } = parseMouseChunk(str);
    for (const dir of wheels) {
      for (const l of this.wheelListeners) l(dir);
    }
    if (cleaned.length > 0) this.write(cleaned);
  }
}

/**
 * Pure parser. Exposed for tests. Strips SGR mouse sequences `\x1b[<b;x;y[Mm]`
 * and returns any wheel events detected, plus the remaining input.
 */
export function parseMouseChunk(str: string): { cleaned: string; wheels: WheelDirection[] } {
  const wheels: WheelDirection[] = [];
  let out = '';
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b' && str[i + 1] === '[' && str[i + 2] === '<') {
      const end = findSgrEnd(str, i + 3);
      if (end >= 0) {
        const body = str.slice(i + 3, end);
        const firstSemi = body.indexOf(';');
        const buttonStr = firstSemi >= 0 ? body.slice(0, firstSemi) : body;
        const button = Number.parseInt(buttonStr, 10);
        if (str[end] === 'M') {
          // Wheel-up = 64, wheel-down = 65. Modifier bits may be OR'd in, so
          // mask them off before comparing.
          const core = button & 0b11000011;
          if (core === 64) wheels.push('up');
          else if (core === 65) wheels.push('down');
        }
        // 'm' = release; wheel events don't emit release, ignore.
        i = end + 1;
        continue;
      }
      // No terminator found in this chunk; bail and pass the rest through.
      out += str.slice(i);
      break;
    }
    out += str[i];
    i += 1;
  }
  return { cleaned: out, wheels };
}

function findSgrEnd(s: string, from: number): number {
  for (let i = from; i < s.length; i += 1) {
    const c = s[i];
    if (c === 'M' || c === 'm') return i;
    // If we hit another ESC, something's malformed — abandon this sequence.
    if (c === '\x1b') return -1;
  }
  return -1;
}
