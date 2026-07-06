import type { ChimeraClient } from '@chimera/client';
import type { CommandRegistry } from '@chimera/commands';
import type { ModelConfig, SandboxMode, SessionId } from '@chimera/core';
import type { ModeRegistry } from '@chimera/modes';
import type { SkillRegistry } from '@chimera/skills';
import { render } from 'ink';
import React from 'react';
import { App, type OverlayHandlers } from './App';
import type { Formatter } from './scrollback';
import { createFilteredStdin } from './input/stdin-filter';
import { deepMerge, getDefaultThemePath, loadUserTheme, pickBaseTheme } from './theme/loader';
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
  reloadSystemPrompt?: (ctx: { cwd: string }) => Promise<string> | string;
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
}

export interface TuiHandle {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

/**
 * Install handlers to exit raw mode on SIGTSTP and restore on SIGCONT.
 * Returns a cleanup function to remove the handlers.
 */
function installSuspendHandlers(stdin: NodeJS.ReadStream): () => void {
  let sigtstpHandler: (() => void) | undefined;
  let sigcontHandler: (() => void) | undefined;

  const install = () => {
    sigtstpHandler = () => {
      try {
        stdin.setRawMode?.(false);
      } catch {
        // Ignore errors if terminal is already closed/disconnected
      }
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
 * Inline render: no alt-screen, no mouse tracking. Committed scrollback
 * entries are written to stdout via <Static>, so the terminal's native
 * scrollback + click-drag selection + wheel scroll all work normally.
 */
export function mountTui(opts: MountOptions): TuiHandle {
  const cleanupSuspendHandlers = installSuspendHandlers(process.stdin);

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
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[>4;0m\x1b[>4m\x1b[<u');
  }
  const base = pickBaseTheme();
  const result = loadUserTheme(getDefaultThemePath());
  if (result.kind === 'error') {
    process.stderr.write(`theme: ${result.message}\n`);
  }
  const theme = result.kind === 'ok' ? deepMerge(base, result.theme) : base;
  const isUserTheme = result.kind === 'ok';
  const activeName = result.kind === 'ok' ? result.activeName : undefined;

  const instance = render(
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
        overlay={opts.overlay}
        reloadSystemPrompt={opts.reloadSystemPrompt}
        formatters={opts.formatters}
        initialPrompt={opts.initialPrompt}
      />
    </ThemeProvider>,
    {
      exitOnCtrlC: false,
      stdin: createFilteredStdin(process.stdin),
    },
  );

  return {
    waitUntilExit: () => instance.waitUntilExit(),
    unmount: () => {
      cleanupSuspendHandlers();
      instance.unmount();
    },
  };
}
