/** Where a screen writer draws: a TTY write stream, or the virtual terminal in tests. */
export interface TerminalOutput {
  columns?: number;
  rows?: number;
  write(chunk: string): unknown;
}

export const SYNC_START = '\x1b[?2026h';
export const SYNC_END = '\x1b[?2026l';
// Stays well under what a terminal reads at once, so a frame never stalls the pty.
const CHUNK_SIZE = 16 * 1024;

/** Write `body` as one synchronized frame, in chunks the terminal can take. */
export function writeFrame(out: TerminalOutput, body: string): void {
  const frame = `${SYNC_START}${body}${SYNC_END}`;
  for (let offset = 0; offset < frame.length; offset += CHUNK_SIZE) {
    out.write(frame.slice(offset, offset + CHUNK_SIZE));
  }
}

/** A component renders its view state to one string per screen row, for a width. */
export type RenderLines<State> = (state: State, width: number) => string[];
