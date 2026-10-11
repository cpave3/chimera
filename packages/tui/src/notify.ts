export type NotificationSetting = 'auto' | 'bell' | 'off';
/** Why the user's attention is wanted. */
export type NotificationReason = 'run_finished' | 'approval' | 'input';
export type Focus = 'focused' | 'unfocused' | 'unknown';
export type NotificationKind = 'none' | 'bell' | 'desktop';

/** A run this long is worth a notification when the terminal's focus is not known. */
const LONG_RUN_MS = 10_000;

/** Focus reporting on and off (`CSI ? 1004 h/l`); the terminal then sends `CSI I` and `CSI O`. */
export const FOCUS_REPORTS_ENABLE = '\x1b[?1004h';
export const FOCUS_REPORTS_DISABLE = '\x1b[?1004l';

export interface NotificationInput {
  setting: NotificationSetting;
  reason: NotificationReason;
  focus: Focus;
  /** How long the run took; only read for `run_finished`. */
  runMs: number;
}

/**
 * Whether an event is worth interrupting the user for. Under `auto` the
 * answer follows the terminal's focus: a user who looks at the terminal
 * needs no notification. A terminal that never reported its focus gets one
 * for what blocks the agent, and for a run only when it was long enough
 * that the user has probably looked away.
 */
export function decideNotification(input: NotificationInput): NotificationKind {
  if (input.setting === 'off') return 'none';
  if (input.setting === 'bell') return 'bell';
  if (input.focus === 'focused') return 'none';
  if (input.focus === 'unfocused') return 'desktop';
  return input.reason !== 'run_finished' || input.runMs >= LONG_RUN_MS ? 'desktop' : 'none';
}

const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

/**
 * What to write to the terminal. A desktop notification is `OSC 9`, which
 * iTerm2, kitty, WezTerm, Ghostty and Windows Terminal show and other
 * terminals ignore; the bell goes with it for those.
 */
export function notificationSequence(kind: NotificationKind, message: string): string {
  if (kind === 'none') return '';
  if (kind === 'bell') return '\x07';
  const text = message.replaceAll('\n', ' ').replace(CONTROL_CHARACTERS, '');
  return `\x07\x1b]9;${text}\x07`;
}

/** The terminal's focus, as far as it has told us. */
export class FocusTracker {
  focus: Focus = 'unknown';

  report(focused: boolean): void {
    this.focus = focused ? 'focused' : 'unfocused';
  }
}
