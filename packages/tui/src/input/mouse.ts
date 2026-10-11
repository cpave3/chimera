/**
 * What reaches the TUI from the pointer. The wheel scrolls the transcript;
 * the left button selects text. `copied` is the TUI's own report that a
 * selection went to the clipboard.
 */
export type MouseEvent =
  | { kind: 'wheel-up' | 'wheel-down' }
  | { kind: 'press' | 'drag' | 'release'; x: number; y: number }
  | { kind: 'copied'; characters: number };

export interface MouseExtraction {
  /** The input with every complete mouse and focus report taken out. */
  rest: string;
  events: MouseEvent[];
  /** Focus reports in the order received: true for gained, false for lost. */
  focus: boolean[];
  /** The start of a report the chunk ended inside; prepend it to the next chunk. */
  incomplete: string;
}

/**
 * Button presses, motion while a button is down, and the wheel, in SGR
 * form. Most terminals still do their own selection while Shift is held.
 */
export const MOUSE_ENABLE = '\x1b[?1002h\x1b[?1006h';
export const MOUSE_DISABLE = '\x1b[?1006l\x1b[?1002l';

const ESCAPE = String.fromCharCode(27);
const SGR_REPORT = new RegExp(`${ESCAPE}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, 'g');
const SGR_REPORT_START = new RegExp(`${ESCAPE}\\[<[\\d;]*$`);
// `CSI I` and `CSI O`, sent while focus reporting (`CSI ? 1004 h`) is on.
const FOCUS_REPORT = new RegExp(`${ESCAPE}\\[([IO])`, 'g');
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const LEFT_BUTTON = 0;
// Set on a report sent because the pointer moved with a button down.
const MOTION_BIT = 32;
// Shift, Alt and Ctrl are reported as bits 4, 8 and 16 of the button code.
const MODIFIER_BITS = 4 | 8 | 16;

/**
 * Split terminal input into the reports the terminal sends on its own
 * (mouse, focus) and everything else. Ink's key parser does not know these
 * reports and would hand them to every input handler as typed text.
 */
export function extractMouseReports(input: string): MouseExtraction {
  const events: MouseEvent[] = [];
  const focus: boolean[] = [];
  const keys = input.replace(FOCUS_REPORT, (_report, letter: string) => {
    focus.push(letter === 'I');
    return '';
  });
  let rest = keys.replace(
    SGR_REPORT,
    (_report, code: string, column: string, row: string, final: string) => {
      const button = Number(code) & ~MODIFIER_BITS;
      // The terminal counts cells from one.
      const point = { x: Number(column) - 1, y: Number(row) - 1 };
      if (button === WHEEL_UP) events.push({ kind: 'wheel-up' });
      else if (button === WHEEL_DOWN) events.push({ kind: 'wheel-down' });
      else if (button === LEFT_BUTTON) {
        events.push({ kind: final === 'M' ? 'press' : 'release', ...point });
      } else if (button === (LEFT_BUTTON | MOTION_BIT) && final === 'M') {
        events.push({ kind: 'drag', ...point });
      }
      return '';
    },
  );
  const cut = rest.match(SGR_REPORT_START);
  const incomplete = cut ? cut[0] : '';
  if (cut) rest = rest.slice(0, cut.index);
  return { rest, events, focus, incomplete };
}

/** Where mouse events go between the terminal input filter and the App. */
export class MouseBus {
  private readonly listeners = new Set<(event: MouseEvent) => void>();

  subscribe(listener: (event: MouseEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: MouseEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
