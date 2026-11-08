import { type TerminalOutput, writeFrame } from './output';
import { onlyStyles } from './sanitize';
import { clipToWidth, displayWidth } from './width';

const ERASE_LINE = '\x1b[2K';
const RESET_STYLE = '\x1b[0m';
const CLEAR_SCREEN_AND_SCROLLBACK = '\x1b[2J\x1b[H\x1b[3J';

/**
 * Draws a list of lines into the terminal's own scrollback, under where the
 * cursor was. It keeps the lines it last wrote and, for each frame, rewrites
 * only the first to the last changed line, moving there relatively. A line
 * that already scrolled off the screen cannot be rewritten that way, so a
 * change there, or a new width, clears the screen and the scrollback and
 * prints everything again.
 */
export class InlineScreen {
  private previous: string[] = [];
  private width = 0;
  private height = 0;
  private started = false;

  constructor(private readonly out: TerminalOutput) {}

  /** The lines on screen, as the last frame left them. */
  get lines(): readonly string[] {
    return this.previous;
  }

  render(next: string[]): void {
    const width = this.out.columns ?? 80;
    const height = this.out.rows ?? 24;
    const lines = next.map((raw) => {
      const line = onlyStyles(raw);
      return displayWidth(line) > width ? clipToWidth(line, width) : line;
    });
    if (!this.started) {
      this.started = true;
      this.write(`\r${this.joined(lines)}`, lines, width, height);
      return;
    }
    if (width !== this.width) {
      this.reprint(lines, width, height);
      return;
    }
    const longest = Math.max(lines.length, this.previous.length);
    let first = -1;
    let last = -1;
    for (let index = 0; index < longest; index += 1) {
      if (lines[index] !== this.previous[index]) {
        if (first < 0) first = index;
        last = index;
      }
    }
    if (first < 0) {
      this.height = height;
      return;
    }
    // The rows still on screen: those above them are in the scrollback.
    const viewportTop = Math.max(0, this.previous.length - Math.min(height, this.height));
    if (first < viewportTop) {
      this.reprint(lines, width, height);
      return;
    }
    let body = '';
    const cursorLine = Math.max(0, this.previous.length - 1);
    if (this.previous.length === 0) {
      body += '\r';
    } else {
      const up = cursorLine - first;
      if (up > 0) body += `\x1b[${up}A`;
      body += '\r';
      // A frame that only adds lines starts on a new one.
      if (up < 0) body += '\r\n'.repeat(-up);
    }
    const lastWritten = Math.min(last, lines.length - 1);
    for (let index = first; index <= lastWritten; index += 1) {
      if (index > first) body += '\r\n';
      body += `${ERASE_LINE}${lines[index]}${RESET_STYLE}`;
    }
    if (lines.length < this.previous.length) {
      // The cursor sits on the last line written; everything below it goes.
      body += lastWritten < first ? `${ERASE_LINE}\x1b[J` : '\x1b[J';
      // Only lines went: back up to the end of the last one that stays.
      if (lastWritten < first && lines.length > 0) body += '\x1b[1A';
    } else if (lastWritten < lines.length - 1) {
      body += `\x1b[${lines.length - 1 - lastWritten}B`;
    }
    this.write(body, lines, width, height);
  }

  /** Clear the screen and the scrollback; the next frame starts at the top. */
  clear(): void {
    writeFrame(this.out, CLEAR_SCREEN_AND_SCROLLBACK);
    this.previous = [];
  }

  /** Forget what is on screen: the next frame is written from the cursor as a first frame. */
  reset(): void {
    this.previous = [];
    this.started = false;
  }

  /** Print everything again from the top of a cleared screen and scrollback. */
  reprint(
    lines = this.previous,
    width = this.out.columns ?? 80,
    height = this.out.rows ?? 24,
  ): void {
    this.write(`${CLEAR_SCREEN_AND_SCROLLBACK}${this.joined(lines)}`, [...lines], width, height);
  }

  private joined(lines: string[]): string {
    return lines.map((line) => `${line}${RESET_STYLE}`).join('\r\n');
  }

  private write(body: string, lines: string[], width: number, height: number): void {
    writeFrame(this.out, body);
    this.previous = lines;
    this.width = width;
    this.height = height;
  }
}
