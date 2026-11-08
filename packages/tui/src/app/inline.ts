import type { RowContext } from '../ledger/rows';
import type { Style } from '../theme/style';
import type { TuiController } from './controller';
import { TranscriptView } from './transcript-view';

/**
 * The inline layout: the transcript followed directly by the chrome (task
 * row, card, prompt box and status line), written into the terminal's own
 * scrollback by the inline screen. The terminal scrolls it; nothing here
 * keeps a scroll position.
 */
export class InlineLayout {
  readonly view = new TranscriptView();

  constructor(private readonly controller: TuiController) {}

  frame(width: number, height: number, style: Style): string[] {
    const { controller } = this;
    const chrome = controller.chrome(width, height, style);
    const { entries, children } = controller.transcript();
    this.view.update(
      controller.banner(width, style),
      entries,
      this.context(width, style, children),
    );
    return [...this.view.lines, '', ...chrome];
  }

  /** What stays in the scrollback after exit: the transcript, without the chrome. */
  exitFrame(width: number, style: Style): string[] {
    const { controller } = this;
    const { entries, children } = controller.transcript();
    this.view.update(
      controller.banner(width, style),
      entries,
      this.context(width, style, children),
    );
    return [...this.view.lines];
  }

  /**
   * Transcript rows do not animate inline: a running row that scrolled above
   * the screen would have to reprint the whole scrollback on every tick.
   * The prompt box's border keeps the spinner.
   */
  private context(
    width: number,
    style: Style,
    children: Parameters<TuiController['rowContext']>[2],
  ): RowContext {
    return { ...this.controller.rowContext(width, style, children), spinner: '○' };
  }

  reset(): void {
    this.view.reset();
  }
}
