import type { ChimeraClient } from '@chimera/client';
import type { CommandRegistry } from '@chimera/commands';
import type { SessionId } from '@chimera/core';
import { render } from 'ink';
import React from 'react';
import { App } from './App';
import {
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  MouseAwareStdin,
  type WheelDirection,
} from './mouse';

export interface MountOptions {
  client: ChimeraClient;
  sessionId: SessionId;
  modelRef: string;
  cwd: string;
  commands?: CommandRegistry;
}

export type WheelSubscriber = (handler: (dir: WheelDirection) => void) => () => void;

export interface TuiHandle {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[H';
const EXIT_ALT_SCREEN = '\x1b[?1049l';

export function mountTui(opts: MountOptions): TuiHandle {
  const isTTY = Boolean(process.stdout.isTTY);
  const useAltScreen = isTTY && process.env.CHIMERA_NO_ALT_SCREEN !== '1';
  const useMouse = isTTY && process.env.CHIMERA_NO_MOUSE !== '1';

  if (useAltScreen) {
    process.stdout.write(ENTER_ALT_SCREEN);
  }
  if (useMouse) {
    process.stdout.write(ENABLE_MOUSE);
  }

  const mouseStdin = useMouse ? new MouseAwareStdin(process.stdin) : null;
  const subscribeWheel: WheelSubscriber = mouseStdin
    ? (h) => mouseStdin.onWheel(h)
    : () => () => {
        // no-op unsubscribe when mouse reporting is disabled
      };

  const cleanup = () => {
    if (useMouse) {
      process.stdout.write(DISABLE_MOUSE);
    }
    if (useAltScreen) {
      process.stdout.write(EXIT_ALT_SCREEN);
    }
    mouseStdin?.close();
  };
  process.once('exit', cleanup);

  const instance = render(
    <App
      client={opts.client}
      sessionId={opts.sessionId}
      modelRef={opts.modelRef}
      cwd={opts.cwd}
      commands={opts.commands}
      subscribeWheel={subscribeWheel}
    />,
    {
      exitOnCtrlC: false,
      stdin: (mouseStdin ?? undefined) as NodeJS.ReadStream | undefined,
    },
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
