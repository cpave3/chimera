import type { ChimeraClient } from '@chimera/client';
import type { CommandRegistry } from '@chimera/commands';
import type { ModelConfig, SandboxMode, SessionId } from '@chimera/core';
import type { ModeRegistry } from '@chimera/modes';
import type { SkillRegistry } from '@chimera/skills';
import { render } from 'ink';
import React from 'react';
import { App, type OverlayHandlers } from './App';
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
   * (e.g., after AGENTS.md/CLAUDE.md changes). Returns the new prompt
   * to send to the server.
   */
  reloadSystemPrompt?: (ctx: { cwd: string }) => Promise<string> | string;
}

export interface TuiHandle {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

/**
 * Inline render: no alt-screen, no mouse tracking. Committed scrollback
 * entries are written to stdout via <Static>, so the terminal's native
 * scrollback + click-drag selection + wheel scroll all work normally.
 */
export function mountTui(opts: MountOptions): TuiHandle {
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
      />
    </ThemeProvider>,
    {
      exitOnCtrlC: false,
      stdin: createFilteredStdin(process.stdin),
    },
  );

  return {
    waitUntilExit: () => instance.waitUntilExit(),
    unmount: () => instance.unmount(),
  };
}
