import { basename, resolve } from 'node:path';
import type { SessionId } from '@chimera/core';
import { type ControllerHooks, TuiController } from './app/controller';
import { FullscreenLayout } from './app/fullscreen';
import { InlineLayout } from './app/inline';
import type { TuiOptions } from './app/options';
import {
  decideNotification,
  FocusTracker,
  type NotificationReason,
  notificationSequence,
} from './notify';
import { AltScreen } from './terminal/alt-screen';
import { type SignalPort, TerminalHost, type TerminalInputStream } from './terminal/host';
import { InlineScreen } from './terminal/inline-screen';
import type { InputEvent } from './terminal/keys';
import { resolveTheme, type TuiLayout } from './theme/loader';
import type { Style } from './theme/style';

export type { OverlayHandlers } from './app/options';

/** What `mountTui` draws on: the process's terminal, or a virtual one in tests. */
export interface TerminalStreams {
  stdin: TerminalInputStream;
  stdout: {
    isTTY?: boolean;
    columns?: number;
    rows?: number;
    write(chunk: string): unknown;
    on(event: 'resize', listener: () => void): unknown;
    off(event: 'resize', listener: () => void): unknown;
  };
  /** Ctrl+Z and the process's stop and continue signals. */
  signals?: SignalPort;
  env?: NodeJS.ProcessEnv;
}

export interface MountOptions extends TuiOptions {
  /** The other live Chimera instances, for the Ink layout's context panel. */
  listPeers?: () => Promise<import('./ContextPanel').Peer[]>;
  /** Injection point for tests: the terminal to draw on. Defaults to the process's. */
  terminal?: TerminalStreams;
}

export interface TuiHandle {
  waitUntilExit(): Promise<void>;
  unmount(): void;
  /** The layout in use, after the terminal had its say. */
  layout: TuiLayout;
  /** The session on screen now: `/new`, `/fork` and `/sessions` change it. */
  activeSessionId(): SessionId;
}

/** The layout to use: fullscreen needs a terminal that can show one. */
export function resolveLayout(
  requested: TuiLayout | undefined,
  terminal: { isTTY: boolean; term: string | undefined },
): TuiLayout {
  if (!terminal.isTTY || terminal.term === 'dumb') return 'inline';
  return requested ?? 'fullscreen';
}

const ATTENTION_TEXT: Record<NotificationReason, string> = {
  run_finished: 'run finished',
  approval: 'approval needed',
  input: 'input needed',
};

/** Frames at most this often while text streams; a burst of events draws once. */
const FRAME_INTERVAL_MS = 16;

/**
 * Mount the TUI. The fullscreen layout takes the alternate screen and the
 * mouse; the inline layout prints into the terminal's own scrollback.
 */
export function mountTui(opts: MountOptions): TuiHandle {
  const terminal: TerminalStreams = opts.terminal ?? {
    stdin: process.stdin as unknown as TerminalInputStream,
    stdout: process.stdout,
  };
  const env = terminal.env ?? process.env;
  const { stdout } = terminal;
  const layout = resolveLayout(opts.layout, { isTTY: stdout.isTTY === true, term: env.TERM });
  const fullscreen = layout === 'fullscreen';
  const tty = stdout.isTTY === true;

  let theme = resolveTheme({ env });
  if (theme.error && !opts.terminal) process.stderr.write(`theme: ${theme.error}\n`);
  let style: Style = theme.style;
  const notifications = opts.notifications ?? 'auto';
  const focusTracker = new FocusTracker();
  const title = `chimera · ${basename(resolve(opts.cwd))}`;

  let frameTimer: NodeJS.Timeout | undefined;
  let lastFrameAt = 0;
  let finished = false;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolveExited) => {
    resolveExit = resolveExited;
  });

  const size = () => ({ width: stdout.columns ?? 80, height: stdout.rows ?? 24 });
  const draw = () => {
    frameTimer = undefined;
    if (finished) return;
    lastFrameAt = Date.now();
    surface.draw();
  };
  const requestRender = () => {
    if (finished || frameTimer) return;
    const wait = Math.max(0, FRAME_INTERVAL_MS - (Date.now() - lastFrameAt));
    frameTimer = setTimeout(draw, wait);
  };

  const hooks: ControllerHooks = {
    requestRender,
    exit: () => finish(),
    handoff: (operation) =>
      host.handoff(async () => {
        surface.leave();
        try {
          return await operation();
        } finally {
          if (!finished) {
            surface.enter();
            requestRender();
          }
        }
      }),
    suspend: () => host.suspend(),
    notify: (reason, detail) => {
      if (!tty) return;
      const kind = decideNotification({
        setting: notifications,
        reason,
        focus: focusTracker.focus,
        runMs: detail.runMs,
      });
      stdout.write(notificationSequence(kind, `${title}: ${ATTENTION_TEXT[reason]}`));
    },
    transcriptReset: () => surface.reset(),
    reloadTheme: () => {
      theme = resolveTheme({ env });
      style = theme.style;
      requestRender();
    },
  };

  const controller = new TuiController(opts, hooks, fullscreen);
  const surface: Surface = fullscreen ? alternateSurface() : inlineSurface();

  /** The fullscreen layout on the alternate screen. */
  function alternateSurface(): Surface {
    const screen = new AltScreen(stdout);
    const view = new FullscreenLayout(controller);
    return {
      draw: () => {
        if (!screen.entered) return;
        const { width, height } = size();
        screen.render(view.frame(width, height, style));
      },
      enter: () => screen.enter(),
      leave: () => screen.leave(),
      resized: () => screen.invalidate(),
      resumed: () => screen.enter(),
      reset: () => view.reset(),
      finish: () => screen.leave(),
      wheel: (lines) => {
        if (!controller.modalCard()?.scroll?.(lines)) view.scrollBy(lines);
        requestRender();
      },
    };
  }

  /** The inline layout in the terminal's own scrollback. */
  function inlineSurface(): Surface {
    const screen = new InlineScreen(stdout);
    const view = new InlineLayout(controller);
    const cursor = (visible: boolean) => {
      if (tty) stdout.write(visible ? SHOW_CURSOR : HIDE_CURSOR);
    };
    return {
      draw: () => {
        const { width, height } = size();
        screen.render(view.frame(width, height, style));
      },
      enter: () => cursor(false),
      leave: () => cursor(true),
      resized: () => {},
      // The shell wrote under the TUI while it was stopped: print it all again.
      resumed: () => {
        cursor(false);
        screen.reprint();
      },
      reset: () => {
        view.reset();
        screen.clear();
      },
      finish: () => {
        const { width } = size();
        screen.render(view.exitFrame(width, style));
        stdout.write('\r\n');
        cursor(true);
      },
      wheel: () => {},
    };
  }

  const host = new TerminalHost({
    stdin: terminal.stdin,
    stdout,
    mouse: fullscreen && opts.mouse !== false,
    focus: notifications === 'auto' && tty,
    modes: tty,
    signals: terminal.signals,
    onInput: (event: InputEvent) => {
      if (event.type === 'focus') {
        focusTracker.report(event.focused);
        return;
      }
      if (event.type === 'mouse') {
        if (event.action === 'wheel-up' || event.action === 'wheel-down') {
          surface.wheel(event.action === 'wheel-up' ? -WHEEL_LINES : WHEEL_LINES);
        }
        return;
      }
      controller.handleInput(event);
    },
  });
  host.onSuspend = () => surface.leave();
  host.onResume = () => {
    surface.resumed();
    draw();
  };

  const onResize = () => {
    surface.resized();
    draw();
  };

  function restore(): void {
    host.stop();
    surface.leave();
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    clearTimeout(frameTimer);
    stdout.off('resize', onResize);
    controller.dispose();
    host.stop();
    surface.finish();
    process.removeListener('exit', restore);
    resolveExit();
  }

  // A crash must not leave the user's shell with the TUI's modes on.
  process.once('exit', restore);
  stdout.on('resize', onResize);
  surface.enter();
  host.start();
  controller.start();
  draw();

  return {
    layout,
    activeSessionId: () => controller.activeSession.sessionId,
    waitUntilExit: () => exited,
    unmount: () => finish(),
  };
}

/** What a layout draws on, and how it lets the terminal go and takes it back. */
interface Surface {
  draw(): void;
  /** Take the screen back after a program that took it over. */
  enter(): void;
  /** Give the screen to a program that takes it over. */
  leave(): void;
  resized(): void;
  /** The process continued after Ctrl+Z. */
  resumed(): void;
  /** The transcript was thrown away. */
  reset(): void;
  /** Leave the TUI for good. */
  finish(): void;
  wheel(lines: number): void;
}

const WHEEL_LINES = 3;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export { TuiController };
