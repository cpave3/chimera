import { type TerminalOutput, writeFrame } from './output';
import { clipToWidth, displayWidth } from './width';

const ENTER = '\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[2J\x1b[H';
const LEAVE = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';
const RESET_STYLE = '\x1b[0m';

/**
 * Draws frames of exactly `rows` lines on the alternate screen, rewriting
 * only the rows that changed. Autowrap is off while it owns the screen, so
 * a full-width row never scrolls the screen.
 */
export class AltScreen {
  private previous: string[] = [];
  private full = true;
  private active = false;

  constructor(private readonly out: TerminalOutput) {}

  get entered(): boolean {
    return this.active;
  }

  enter(): void {
    this.out.write(ENTER);
    this.active = true;
    this.invalidate();
  }

  leave(): void {
    if (!this.active) return;
    this.out.write(LEAVE);
    this.active = false;
  }

  /** The next frame redraws every row: after a resize, or after another program drew. */
  invalidate(): void {
    this.full = true;
  }

  render(next: string[]): void {
    const width = this.out.columns ?? 80;
    const height = this.out.rows ?? 24;
    const rows = Array.from({ length: height }, (_, index) => {
      const line = next[index] ?? '';
      return displayWidth(line) > width ? clipToWidth(line, width) : line;
    });
    let body = this.full ? '\x1b[2J' : '';
    rows.forEach((row, index) => {
      if (!this.full && row === this.previous[index]) return;
      // Erasing on a full row would wipe its last cell: the cursor stays there.
      const erase = displayWidth(row) < width ? '\x1b[K' : '';
      body += `\x1b[${index + 1};1H${row}${RESET_STYLE}${erase}`;
    });
    this.full = false;
    this.previous = rows;
    if (body !== '') writeFrame(this.out, body);
  }
}
