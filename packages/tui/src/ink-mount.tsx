import { basename, resolve } from 'node:path';
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
import chalk from 'chalk';
import { render } from 'ink';
import { App } from './App';
import type { Peer } from './ContextPanel';
import { clipboardSequence, writeClipboardText } from './clipboard';
import { MOUSE_DISABLE, MOUSE_ENABLE, MouseBus, type MouseEvent } from './input/mouse';
import { PasteRegistry } from './input/paste';
import { type Region, ScreenSelection } from './input/screen-selection';
import { createFilteredStdin } from './input/stdin-filter';
import type { MountOptions, TuiHandle } from './mount';
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
import { toLegacyTheme } from './theme/legacy';
import { resolveTheme, type TuiLayout } from './theme/loader';
import { ThemeProvider } from './theme/ThemeProvider';

const SELECTION_FLASH_MS = 1_200;

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
/** The inline layout on Ink, until it moves to the new renderer. */
export function mountInkTui(opts: MountOptions, layout: TuiLayout): TuiHandle {
  const { stdout } = process;
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
      selection?.clear();
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
  const resolved = resolveTheme();
  if (resolved.error) process.stderr.write(`theme: ${resolved.error}\n`);
  const theme = toLegacyTheme(resolved.tokens, resolved.style.level === 'none');
  const { isUserTheme, activeName } = resolved;

  const pasteRegistry = new PasteRegistry();
  const mouse = new MouseBus();

  // Mouse selection. The terminal cannot select for the user while the TUI
  // takes mouse reports, so the TUI does it: drag paints a highlight over
  // the last frame, and release sends the text to the clipboard.
  let selectableRegions: Region[] = [];
  const accent = theme.ui.accent;
  const selection = captureMouse
    ? new ScreenSelection({
        write: (text) => stdout.write(text),
        regionAt: (point) =>
          selectableRegions.find((region) => point.x >= region.left && point.x < region.right) ??
          selectableRegions[0] ?? { left: 0, right: stdout.columns ?? 80 },
        highlight: accent.startsWith('#')
          ? chalk
              .bgHex(accent)
              .hex(theme.base.background?.startsWith('#') ? theme.base.background : '#000000')
          : chalk.inverse,
      })
    : undefined;
  let selectionFlash: NodeJS.Timeout | undefined;
  const onMouse = (event: MouseEvent) => {
    if (event.kind === 'press') {
      clearTimeout(selectionFlash);
      selection?.press(event.x, event.y);
    } else if (event.kind === 'drag') {
      selection?.drag(event.x, event.y);
    } else if (event.kind === 'release') {
      const text = selection?.release();
      if (!text) return;
      // Both ways: the terminal's clipboard sequence reaches the user's
      // machine over SSH, and the system tool works where a terminal
      // ignores the sequence.
      stdout.write(clipboardSequence(text));
      void writeClipboardText(text);
      mouse.emit({ kind: 'copied', characters: text.length });
      // The highlight shows what was taken, then goes: the screen under it moves on.
      selectionFlash = setTimeout(() => selection?.clear(), SELECTION_FLASH_MS);
    } else {
      mouse.emit(event);
    }
  };
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
    <ThemeProvider theme={theme} isUserTheme={isUserTheme} activeName={activeName}>
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
        osSandbox={opts.osSandbox}
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
        memoryIndexPath={opts.memoryIndexPath}
        notify={notify}
        onSelectableRegions={(regions) => {
          selectableRegions = regions;
        }}
        screenSelection={selection}
        onActiveSessionChange={(sessionId) => {
          activeSessionId = sessionId;
        }}
      />
    </ThemeProvider>,
    {
      exitOnCtrlC: false,
      stdin: createFilteredStdin(process.stdin, pasteRegistry, {
        onMouse,
        onFocus: (focused) => focusTracker.report(focused),
      }),
      ...(fullscreen ? { alternateBuffer: true, incrementalRendering: true } : {}),
      ...(selection
        ? { onRender: ({ output }: { output: string }) => selection.frame(output) }
        : {}),
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
