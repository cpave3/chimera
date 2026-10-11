import type { ChimeraClient } from '@chimera/client';
import type { CommandRegistry } from '@chimera/commands';
import type {
  HostAuthenticationCheckResult,
  HostAuthenticationResult,
  ModelConfig,
  SandboxMode,
  SessionId,
} from '@chimera/core';
import type { ModeRegistry } from '@chimera/modes';
import type { SkillRegistry } from '@chimera/skills';
import { basename, resolve } from 'node:path';
import { render } from 'ink';
import { App, type OverlayHandlers } from './App';
import type { Peer } from './ContextPanel';
import { MOUSE_DISABLE, MOUSE_ENABLE, MouseBus } from './input/mouse';
import { PasteRegistry } from './input/paste';
import { createFilteredStdin } from './input/stdin-filter';
import {
  decideNotification,
  FOCUS_REPORTS_DISABLE,
  FOCUS_REPORTS_ENABLE,
  FocusTracker,
  type NotificationReason,
  type NotificationSetting,
  notificationSequence,
} from './notify';
import type { Formatter } from './scrollback';
import {
  deepMerge,
  getDefaultThemePath,
  loadUserTheme,
  pickBaseTheme,
  type TuiLayout,
} from './theme/loader';
import { ThemeProvider } from './theme/ThemeProvider';

export interface MountOptions {
  client: ChimeraClient;
  sessionId: SessionId;
  modelRef: string;
  /**
   * Resolved model configuration — required so that `/new` and `/fork`
   * can create new sessions with the same model defaults as the current one.
   */
  model: ModelConfig;
  cwd: string;
  commands?: CommandRegistry;
  skills?: SkillRegistry;
  modes?: ModeRegistry;
  cycleModes?: string[];
  initialMode?: string;
  sandboxMode?: SandboxMode;
  overlay?: OverlayHandlers;
  /**
   * When provided, called by `/reload` to re-compose the system prompt
   * (e.g., after AGENTS.md/AGENTS.local.md/CLAUDE.md changes). Returns the new prompt
   * to send to the server.
   */
  reloadSystemPrompt?: (ctx: { cwd: string; sessionId: SessionId }) => Promise<string> | string;
  /**
   * Per-tool scrollback formatters keyed by tool name. Used by `Scrollback`
   * to render tool entries during session rehydration (resume / fork /
   * `/sessions` switch). Live tool calls already carry `display` on their
   * events so they don't depend on this map.
   */
  formatters?: Record<string, Formatter>;
  /**
   * Initial message to submit when the TUI mounts (e.g. from `--prompt <text>`).
   * Goes through the same handling as if the user typed it and pressed Enter,
   * so slash commands are respected.
   */
  initialPrompt?: string;
  checkSudo?: (request: {
    requestId: string;
    command: string;
    signal?: AbortSignal;
  }) => Promise<HostAuthenticationCheckResult>;
  authenticateSudo?: (request: {
    requestId: string;
    command: string;
    password: Uint8Array;
    signal?: AbortSignal;
  }) => Promise<HostAuthenticationResult>;
  /**
   * `fullscreen` (the default) owns the alternate screen; `inline` prints
   * into the terminal's own scrollback. A terminal that cannot show a
   * fullscreen program gets `inline` whatever is asked for.
   */
  layout?: TuiLayout;
  /** False leaves the mouse to the terminal; the wheel then does not scroll the transcript. */
  mouse?: boolean;
  /** The other live Chimera instances, for the fullscreen context panel. */
  listPeers?: () => Promise<Peer[]>;
  /** Lines to show at the top of the transcript when the TUI starts. */
  startupNotices?: string[];
  /**
   * How to ask for attention when a run ends, a permission request opens or
   * the agent needs input. `auto` (the default) notifies through the
   * terminal when it is not focused; `bell` always rings; `off` is silent.
   */
  notifications?: NotificationSetting;
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

// Autowrap off while the TUI owns the screen, as Ink sets it on entry.
const ENTER_ALTERNATE_SCREEN = '\x1b[?1049h\x1b[?7l';
const LEAVE_ALTERNATE_SCREEN = '\x1b[?7h\x1b[?1049l';

/**
 * Install handlers to exit raw mode on SIGTSTP and restore on SIGCONT.
 * Returns a cleanup function to remove the handlers.
 */
function installSuspendHandlers(
  stdin: NodeJS.ReadStream,
  screen: { leave(): void; enter(): void; repaint(): void },
): () => void {
  let sigtstpHandler: (() => void) | undefined;
  let sigcontHandler: (() => void) | undefined;

  const install = () => {
    sigtstpHandler = () => {
      try {
        stdin.setRawMode?.(false);
      } catch {
        // Ignore errors if terminal is already closed/disconnected
      }
      screen.leave();
      process.kill(process.pid, 'SIGTSTP');
    };
    process.once('SIGTSTP', sigtstpHandler);
  };

  install();

  sigcontHandler = () => {
    try {
      stdin.setRawMode?.(true);
    } catch {
      // Ignore errors if terminal is closed/disconnected
    }
    install();
    screen.enter();
    screen.repaint();
    // Emit a resize event to force Ink to redraw. Without this, the TUI
    // stays blank until the next keystroke because React does not know the
    // terminal state may have changed while we were suspended.
    if (process.stdout.isTTY) {
      process.stdout.emit('resize');
    }
  };
  process.on('SIGCONT', sigcontHandler);

  return () => {
    if (sigtstpHandler) {
      process.removeListener('SIGTSTP', sigtstpHandler);
    }
    if (sigcontHandler) {
      process.removeListener('SIGCONT', sigcontHandler);
    }
  };
}

/**
 * Mount the TUI on the terminal. The fullscreen layout takes the alternate
 * screen and the mouse wheel; the inline layout takes neither, so the
 * terminal's native scrollback, selection and wheel all work as usual.
 */
export function mountTui(opts: MountOptions): TuiHandle {
  const { stdout } = process;
  const layout = resolveLayout(opts.layout, {
    isTTY: stdout.isTTY === true,
    term: process.env.TERM,
  });
  const fullscreen = layout === 'fullscreen';
  const captureMouse = fullscreen && opts.mouse !== false;
  const notifications = opts.notifications ?? 'auto';
  // Only `auto` reads the focus; the other settings need no reports.
  const reportFocus = notifications === 'auto' && stdout.isTTY === true;
  const focusTracker = new FocusTracker();
  // What the TUI turned on in the terminal, beyond what Ink manages itself.
  const terminalModesOff = `${captureMouse ? MOUSE_DISABLE : ''}${reportFocus ? FOCUS_REPORTS_DISABLE : ''}`;
  const terminalModesOn = `${captureMouse ? MOUSE_ENABLE : ''}${reportFocus ? FOCUS_REPORTS_ENABLE : ''}`;
  let instance: ReturnType<typeof render> | undefined;
  // Around a program that takes the terminal over: it must not receive the
  // reports the TUI asked for, nor draw on the TUI's screen.
  const screen = {
    leave() {
      if (!stdout.isTTY) return;
      stdout.write(`${terminalModesOff}${fullscreen ? LEAVE_ALTERNATE_SCREEN : ''}`);
    },
    enter() {
      if (!stdout.isTTY) return;
      stdout.write(`${fullscreen ? ENTER_ALTERNATE_SCREEN : ''}${terminalModesOn}`);
    },
    // What Ink remembers of the screen is stale once another program drew on it.
    repaint() {
      if (fullscreen) instance?.clear();
    },
  };
  const cleanupSuspendHandlers = installSuspendHandlers(process.stdin, screen);

  // Disable terminal keyboard-protocol extensions that emit byte
  // sequences Ink's keypress parser doesn't understand. Without these,
  // Shift+Enter / modified-Enter chords leak as literal `[27;<mod>;13~`
  // characters into the prompt buffer. We send the full set rather than
  // probing terminal capability, since unsupported sequences are silently
  // ignored:
  //   - `\x1b[>4;0m`  — xterm modifyOtherKeys mode 0 (disable)
  //   - `\x1b[>4m`    — xterm modifyOtherKeys default (also disable)
  //   - `\x1b[<u`     — kitty keyboard protocol pop-all (disable)
  // After this, Shift+Enter falls back to plain Enter — the portable
  // `\<Enter>` form remains the documented newline trigger.
  if (stdout.isTTY) {
    stdout.write('\x1b[>4;0m\x1b[>4m\x1b[<u');
  }
  const base = pickBaseTheme(process.env, layout);
  const result = loadUserTheme(getDefaultThemePath());
  if (result.kind === 'error') {
    process.stderr.write(`theme: ${result.message}\n`);
  }
  const theme = result.kind === 'ok' ? deepMerge(base, result.theme) : base;
  const isUserTheme = result.kind === 'ok';
  const activeName = result.kind === 'ok' ? result.activeName : undefined;

  const pasteRegistry = new PasteRegistry();
  const mouse = new MouseBus();
  if (stdout.isTTY) stdout.write('\x1b[?2004h');
  let activeSessionId = opts.sessionId;

  let restored = false;
  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    cleanupSuspendHandlers();
    if (!stdout.isTTY) return;
    stdout.write(`${terminalModesOff}\x1b[?2004l`);
  };
  const title = `chimera · ${basename(resolve(opts.cwd))}`;
  const notify = (reason: NotificationReason, detail: { runMs: number }) => {
    if (!stdout.isTTY) return;
    const kind = decideNotification({
      setting: notifications,
      reason,
      focus: focusTracker.focus,
      runMs: detail.runMs,
    });
    stdout.write(notificationSequence(kind, `${title}: ${ATTENTION_TEXT[reason]}`));
  };
  // A crash must not leave the user's shell with wheel reports turned on.
  process.once('exit', restoreTerminal);

  instance = render(
    <ThemeProvider theme={theme} isUserTheme={isUserTheme} activeName={activeName} layout={layout}>
      <App
        client={opts.client}
        sessionId={opts.sessionId}
        modelRef={opts.modelRef}
        model={opts.model}
        cwd={opts.cwd}
        commands={opts.commands}
        skills={opts.skills}
        modes={opts.modes}
        cycleModes={opts.cycleModes}
        initialMode={opts.initialMode}
        sandboxMode={opts.sandboxMode}
        overlay={opts.overlay}
        reloadSystemPrompt={opts.reloadSystemPrompt}
        formatters={opts.formatters}
        initialPrompt={opts.initialPrompt}
        checkSudo={opts.checkSudo}
        authenticateSudo={opts.authenticateSudo}
        pasteRegistry={pasteRegistry}
        layout={layout}
        mouse={mouse}
        screen={screen}
        listPeers={opts.listPeers}
        startupNotices={opts.startupNotices}
        notify={notify}
        onActiveSessionChange={(sessionId) => {
          activeSessionId = sessionId;
        }}
      />
    </ThemeProvider>,
    {
      exitOnCtrlC: false,
      stdin: createFilteredStdin(process.stdin, pasteRegistry, {
        onMouse: (event) => mouse.emit(event),
        onFocus: (focused) => focusTracker.report(focused),
      }),
      ...(fullscreen ? { alternateBuffer: true, incrementalRendering: true } : {}),
    },
  );
  if (stdout.isTTY) stdout.write(terminalModesOn);
  const mounted = instance;

  return {
    layout,
    activeSessionId: () => activeSessionId,
    waitUntilExit: async () => {
      try {
        await mounted.waitUntilExit();
      } finally {
        restoreTerminal();
      }
    },
    unmount: () => {
      mounted.unmount();
      restoreTerminal();
    },
  };
}
