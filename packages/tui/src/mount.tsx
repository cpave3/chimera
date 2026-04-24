import type { ChimeraClient } from '@chimera/client';
import type { CommandRegistry } from '@chimera/commands';
import type { SessionId } from '@chimera/core';
import { render } from 'ink';
import React from 'react';
import { App } from './App';

export interface MountOptions {
  client: ChimeraClient;
  sessionId: SessionId;
  modelRef: string;
  cwd: string;
  commands?: CommandRegistry;
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
  const instance = render(
    <App
      client={opts.client}
      sessionId={opts.sessionId}
      modelRef={opts.modelRef}
      cwd={opts.cwd}
      commands={opts.commands}
    />,
    {
      exitOnCtrlC: false,
    },
  );

  return {
    waitUntilExit: () => instance.waitUntilExit(),
    unmount: () => instance.unmount(),
  };
}
