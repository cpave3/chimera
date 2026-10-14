export interface LiveRegionInput {
  /** Terminal height. */
  rows: number;
  /** Lines of the prompt buffer. */
  promptLines: number;
  taskCount: number;
  queuedCount: number;
  helpOpen: boolean;
  /** A permission prompt or a picker is open. */
  modalOpen: boolean;
}

export interface LiveRegionPlan {
  /** Lines the task panel may use; 0 hides it. */
  taskLines: number;
  /** Queued messages to list. */
  queuedLines: number;
  /** Lines held for everything else in the live region. */
  reservedLines: number;
  /** Lines a permission prompt may take; the request scrolls in one that needs more. */
  permissionLines: number;
}

export const MAX_TASK_LINES = 6;
export const MAX_QUEUED_LINES = 3;
// Activity line, status row, and the prompt box's two border lines.
const FIXED_LINES = 4;
// In-flight transcript entries: streamed text spills at 8 lines, plus a
// tool line and the blank line above each.
const IN_FLIGHT_RESERVE = 11;
// The status rows and the prompt box's border, which sit under a permission prompt.
const LINES_UNDER_PERMISSION = 3;
// A permission prompt's border, padding and choices, with a line of the request.
const MIN_PERMISSION_LINES = 14;

/**
 * Split the live region's height among its optional parts. Ink redraws the
 * whole screen, and wipes the terminal's scrollback, once the region it
 * repaints is as tall as the terminal; so the optional parts only get the
 * rows left after the parts that must always show.
 */
export function planLiveRegion(input: LiveRegionInput): LiveRegionPlan {
  const reservedLines = FIXED_LINES + input.promptLines + IN_FLIGHT_RESERVE;
  let free = input.rows - 1 - reservedLines;
  const queuedLines = Math.max(0, Math.min(input.queuedCount, MAX_QUEUED_LINES, free));
  free -= queuedLines;
  const wanted = input.taskCount > 0 ? Math.min(input.taskCount + 1, MAX_TASK_LINES) : 0;
  const crowded = input.modalOpen || input.helpOpen;
  // A header with no task under it says nothing.
  const taskLines = crowded || Math.min(wanted, free) < 2 ? 0 : Math.min(wanted, free);
  // The prompt may push what is above it off the screen, but all of it must
  // show at once: its choices are at the bottom and its request at the top.
  const permissionLines = Math.max(
    MIN_PERMISSION_LINES,
    input.rows - 1 - LINES_UNDER_PERMISSION - input.promptLines,
  );
  return { taskLines, queuedLines, reservedLines, permissionLines };
}
