import { basename, resolve } from 'node:path';
import type { SessionId } from '@chimera/core';
import { type ControllerHooks, TuiController } from './app/controller';
import { FullscreenLayout } from './app/fullscreen';
import type { TuiOptions } from './app/options';
import { mountInkTui } from './ink-mount';
import {
  decideNotification,
  FocusTracker,
  type NotificationReason,
  notificationSequence,
} from './notify';
import { AltScreen } from './terminal/alt-screen';
import { type SignalPort, TerminalHost, type TerminalInputStream } from './terminal/host';
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
  if (layout === 'inline' && !opts.terminal) return mountInkTui(opts, layout);

  let theme = resolveTheme({ env });
  if (theme.error && !opts.terminal) process.stderr.write(`theme: ${theme.error}\n`);
  let style: Style = theme.style;
  const notifications = opts.notifications ?? 'auto';
  const focusTracker = new FocusTracker();
  const screen = new AltScreen(stdout);
  const title = `chimera · ${basename(resolve(opts.cwd))}`;

  let frameTimer: NodeJS.Timeout | undefined;
  let lastFrameAt = 0;
  let finished = false;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolveExited) => {
    resolveExit = resolveExited;
  });

  const draw = () => {
    frameTimer = undefined;
    if (finished || !screen.entered) return;
    lastFrameAt = Date.now();
    screen.render(fullscreen.frame(stdout.columns ?? 80, stdout.rows ?? 24, style));
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
        screen.leave();
        try {
          return await operation();
        } finally {
          if (!finished) {
            screen.enter();
            requestRender();
          }
        }
      }),
    suspend: () => host.suspend(),
    notify: (reason, detail) => {
      if (stdout.isTTY !== true) return;
      const kind = decideNotification({
        setting: notifications,
        reason,
        focus: focusTracker.focus,
        runMs: detail.runMs,
      });
      stdout.write(notificationSequence(kind, `${title}: ${ATTENTION_TEXT[reason]}`));
    },
    transcriptReset: () => fullscreen.reset(),
    reloadTheme: () => {
      theme = resolveTheme({ env });
      style = theme.style;
      requestRender();
    },
  };

  const controller = new TuiController(opts, hooks, true);
  const fullscreen = new FullscreenLayout(controller);
  const host = new TerminalHost({
    stdin: terminal.stdin,
    stdout,
    mouse: opts.mouse !== false,
    focus: notifications === 'auto' && stdout.isTTY === true,
    signals: terminal.signals,
    onInput: (event: InputEvent) => {
      if (event.type === 'focus') {
        focusTracker.report(event.focused);
        return;
      }
      if (event.type === 'mouse') {
        if (event.action === 'wheel-up' || event.action === 'wheel-down') {
          if (!controller.modalCard()?.scroll?.(event.action === 'wheel-up' ? -3 : 3)) {
            fullscreen.scrollBy(event.action === 'wheel-up' ? -3 : 3);
          }
          requestRender();
        }
        return;
      }
      controller.handleInput(event);
    },
  });
  host.onSuspend = () => screen.leave();
  host.onResume = () => {
    screen.enter();
    draw();
  };

  const onResize = () => {
    screen.invalidate();
    draw();
  };

  function restore(): void {
    host.stop();
    screen.leave();
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    clearTimeout(frameTimer);
    stdout.off('resize', onResize);
    controller.dispose();
    restore();
    process.removeListener('exit', restore);
    resolveExit();
  }

  // A crash must not leave the user's shell with the TUI's modes on.
  process.once('exit', restore);
  stdout.on('resize', onResize);
  screen.enter();
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

export { TuiController };
