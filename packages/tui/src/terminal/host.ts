import { type InputEvent, KeyParser } from './keys';
import type { TerminalOutput } from './output';

/** What the host needs of stdin: a TTY read stream, or the virtual input in tests. */
export interface TerminalInputStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** Process signals, injectable so tests do not stop the test runner. */
export interface SignalPort {
  on(signal: 'SIGTSTP' | 'SIGCONT', handler: () => void): unknown;
  off(signal: 'SIGTSTP' | 'SIGCONT', handler: () => void): unknown;
  kill(signal: 'SIGTSTP'): void;
}

const processSignals: SignalPort = {
  on: (signal, handler) => process.on(signal, handler),
  off: (signal, handler) => process.off(signal, handler),
  kill: (signal) => process.kill(process.pid, signal),
};

// Kitty progressive enhancement, level 1: disambiguate escape codes.
const KITTY_ON = '\x1b[>1u';
const KITTY_OFF = '\x1b[<u';
// modifyOtherKeys 1; tmux turns on its extended keys for it when allowed.
const MODIFY_OTHER_KEYS_ON = '\x1b[>4;1m';
const MODIFY_OTHER_KEYS_OFF = '\x1b[>4;0m';
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';
// Button presses, motion with a button down, and the wheel, in SGR form.
export const MOUSE_ON = '\x1b[?1002h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l';
export const FOCUS_ON = '\x1b[?1004h';
export const FOCUS_OFF = '\x1b[?1004l';

const DEFAULT_ESCAPE_TIMEOUT_MS = 50;

export interface TerminalHostOptions {
  stdin: TerminalInputStream;
  stdout: TerminalOutput;
  /** Capture the mouse: the fullscreen layout, unless `tui.mouse` is false. */
  mouse: boolean;
  /** Ask for focus reports, for notifications that depend on focus. */
  focus?: boolean;
  onInput(event: InputEvent): void;
  signals?: SignalPort;
  escapeTimeoutMs?: number;
}

/**
 * Owns the terminal's input side: raw mode, the key reporting modes, and
 * the parser. It turns the modes on when it starts and when it gets the
 * terminal back (after suspend, an editor or the pager), and restores them
 * whenever it lets the terminal go.
 */
export class TerminalHost {
  /** Called after the modes are restored and before the process stops. */
  onSuspend?: () => void;
  /** Called after the modes are back on when the process continues. */
  onResume?: () => void;

  private readonly parser = new KeyParser();
  private readonly signals: SignalPort;
  private escapeTimer: NodeJS.Timeout | undefined;
  private running = false;
  private listening = false;

  constructor(private readonly options: TerminalHostOptions) {
    this.signals = options.signals ?? processSignals;
  }

  private readonly onData = (chunk: string | Buffer) => {
    clearTimeout(this.escapeTimer);
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const event of this.parser.feed(text)) this.options.onInput(event);
    if (this.parser.pending) {
      this.escapeTimer = setTimeout(() => {
        for (const event of this.parser.flush()) this.options.onInput(event);
      }, this.options.escapeTimeoutMs ?? DEFAULT_ESCAPE_TIMEOUT_MS);
    }
  };

  private readonly onStop = () => this.suspend();
  private readonly onContinue = () => this.resume();

  get modesOn(): string {
    const { mouse, focus } = this.options;
    return `${KITTY_ON}${MODIFY_OTHER_KEYS_ON}${BRACKETED_PASTE_ON}${mouse ? MOUSE_ON : ''}${focus ? FOCUS_ON : ''}`;
  }

  get modesOff(): string {
    const { mouse, focus } = this.options;
    return `${focus ? FOCUS_OFF : ''}${mouse ? MOUSE_OFF : ''}${BRACKETED_PASTE_OFF}${MODIFY_OTHER_KEYS_OFF}${KITTY_OFF}`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.stdin.setEncoding?.('utf8');
    this.takeTerminal();
    this.signals.on('SIGTSTP', this.onStop);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.signals.off('SIGTSTP', this.onStop);
    this.signals.off('SIGCONT', this.onContinue);
    this.releaseTerminal();
  }

  /** Ctrl+Z: give the terminal back to the shell and stop the process. */
  suspend(): void {
    if (!this.running) return;
    this.releaseTerminal();
    this.onSuspend?.();
    this.signals.off('SIGTSTP', this.onStop);
    this.signals.on('SIGCONT', this.onContinue);
    this.signals.kill('SIGTSTP');
  }

  private resume(): void {
    this.signals.off('SIGCONT', this.onContinue);
    if (!this.running) return;
    this.signals.on('SIGTSTP', this.onStop);
    this.takeTerminal();
    this.onResume?.();
  }

  /**
   * Run a program that owns the terminal while it runs: an editor or a
   * pager. Input typed for it never reaches the TUI.
   */
  async handoff<T>(operation: () => Promise<T>): Promise<T> {
    this.releaseTerminal();
    try {
      return await operation();
    } finally {
      if (this.running) this.takeTerminal();
    }
  }

  private takeTerminal(): void {
    const { stdin, stdout } = this.options;
    try {
      stdin.setRawMode?.(true);
    } catch {
      // A closed terminal cannot change mode; there is nothing to restore later.
    }
    if (!this.listening) {
      stdin.on('data', this.onData);
      this.listening = true;
    }
    stdin.resume();
    stdout.write(this.modesOn);
  }

  private releaseTerminal(): void {
    const { stdin, stdout } = this.options;
    clearTimeout(this.escapeTimer);
    if (this.listening) {
      stdin.removeListener('data', this.onData);
      this.listening = false;
    }
    stdin.pause();
    stdout.write(this.modesOff);
    try {
      stdin.setRawMode?.(false);
    } catch {
      // As above.
    }
  }
}
