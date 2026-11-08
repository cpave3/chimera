import type { Style } from '../theme/style';
import type { TranscriptScroller, TuiController } from './controller';
import { TranscriptView } from './transcript-view';

/**
 * The fullscreen layout: the transcript in a viewport that fills the
 * screen above the chrome (task row, card, prompt box and status line),
 * which stays pinned to the bottom. The viewport follows the newest output
 * until the user scrolls up; then new output does not move what they read.
 */
export class FullscreenLayout implements TranscriptScroller {
  readonly view = new TranscriptView();
  /** Lines scrolled up from the newest output; 0 follows it. */
  offset = 0;
  private lastTotal = 0;
  private viewport = 1;

  constructor(private readonly controller: TuiController) {
    controller.scroller = this;
  }

  get following(): boolean {
    return this.offset === 0;
  }

  frame(width: number, height: number, style: Style): string[] {
    const { controller } = this;
    const chrome = controller.chrome(width, height, style);
    const { entries, children } = controller.transcript();
    this.view.update(
      controller.banner(width, style),
      entries,
      controller.rowContext(width, style, children),
    );
    this.viewport = Math.max(1, height - chrome.length);
    const total = this.view.lines.length;
    if (this.offset > 0 && total > this.lastTotal) this.offset += total - this.lastTotal;
    this.lastTotal = total;
    this.offset = Math.max(0, Math.min(this.offset, total - this.viewport));
    const end = total - this.offset;
    const rows = this.view.lines.slice(Math.max(0, end - this.viewport), end);
    while (rows.length < this.viewport) rows.push('');
    return [...rows, ...chrome].slice(-height);
  }

  /** The transcript was thrown away. */
  reset(): void {
    this.view.reset();
    this.offset = 0;
    this.lastTotal = 0;
  }

  scrollBy(lines: number): void {
    this.offset = Math.max(0, this.offset - lines);
  }

  scrollPages(pages: number): void {
    this.scrollBy(pages * Math.max(1, this.viewport - 1));
  }

  toTop(): void {
    this.offset = Number.MAX_SAFE_INTEGER;
  }

  toEnd(): void {
    this.offset = 0;
  }
}
