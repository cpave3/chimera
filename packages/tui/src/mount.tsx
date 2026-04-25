import type { ChimeraClient } from '@chimera/client';
import type { CommandRegistry } from '@chimera/commands';
import type { SandboxMode, SessionId } from '@chimera/core';
import type { SkillRegistry } from '@chimera/skills';
import { render } from 'ink';
import React from 'react';
import { App, type OverlayHandlers } from './App';
import {
  deepMerge,
  getDefaultThemePath,
  loadUserTheme,
  pickBaseTheme,
} from './theme/loader';
import { ThemeProvider } from './theme/ThemeProvider';

export interface MountOptions {
  client: ChimeraClient;
  sessionId: SessionId;
  modelRef: string;
  cwd: string;
  commands?: CommandRegistry;
  skills?: SkillRegistry;
  sandboxMode?: SandboxMode;
  overlay?: OverlayHandlers;
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
        cwd={opts.cwd}
        commands={opts.commands}
        skills={opts.skills}
        sandboxMode={opts.sandboxMode}
        overlay={opts.overlay}
      />
    </ThemeProvider>,
    {
      exitOnCtrlC: false,
    },
  );

  return {
    waitUntilExit: () => instance.waitUntilExit(),
    unmount: () => instance.unmount(),
  };
}
