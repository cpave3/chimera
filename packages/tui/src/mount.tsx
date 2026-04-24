import type { ChimeraClient } from '@chimera/client';
import type { SessionId } from '@chimera/core';
import { render } from 'ink';
import React from 'react';
import { App } from './App';

export interface MountOptions {
  client: ChimeraClient;
  sessionId: SessionId;
  modelRef: string;
  cwd: string;
}

export interface TuiHandle {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[H';
const EXIT_ALT_SCREEN = '\x1b[?1049l';

export function mountTui(opts: MountOptions): TuiHandle {
  const useAltScreen = Boolean(process.stdout.isTTY) && process.env.CHIMERA_NO_ALT_SCREEN !== '1';
  if (useAltScreen) {
    process.stdout.write(ENTER_ALT_SCREEN);
  }

  const cleanup = () => {
    if (useAltScreen) {
      process.stdout.write(EXIT_ALT_SCREEN);
    }
  };
  process.once('exit', cleanup);

  const instance = render(
    <App
      client={opts.client}
      sessionId={opts.sessionId}
      modelRef={opts.modelRef}
      cwd={opts.cwd}
    />,
  );
  return {
    waitUntilExit: async () => {
      try {
        await instance.waitUntilExit();
      } finally {
        cleanup();
        process.removeListener('exit', cleanup);
      }
    },
    unmount: () => {
      instance.unmount();
      cleanup();
      process.removeListener('exit', cleanup);
    },
  };
}
