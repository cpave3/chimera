const BRACKETED_PASTE_DISABLE = '\x1b[?2004l';
const BRACKETED_PASTE_ENABLE = '\x1b[?2004h';

export interface TerminalOwner {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export async function withTerminalHandoff<T>(
  terminal: TerminalOwner,
  operation: () => Promise<T>,
  options: { requireTty?: boolean } = {},
): Promise<T> {
  const { stdin, stdout } = terminal;
  if (options.requireTty !== false && (stdin.isTTY !== true || stdout.isTTY !== true)) {
    throw new Error('sudo authentication requires an owner-local terminal.');
  }

  const wasRaw = stdin.isRaw === true;
  try {
    if (stdout.isTTY) stdout.write(BRACKETED_PASTE_DISABLE);
    if (wasRaw) stdin.setRawMode?.(false);
    stdin.pause();
    return await operation();
  } finally {
    try {
      while (stdin.read?.() !== null) {
        // Drain input entered while the child owned the terminal.
      }
    } finally {
      try {
        if (wasRaw) stdin.setRawMode?.(true);
      } finally {
        try {
          if (stdout.isTTY) stdout.write(BRACKETED_PASTE_ENABLE);
        } finally {
          stdin.resume();
        }
      }
    }
  }
}
