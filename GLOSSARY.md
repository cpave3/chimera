# Chimera

A single-agent coding tool with a terminal UI, a server and a headless mode.

## TUI

**Status line**:
The configurable bar at the bottom of the TUI that shows session facts such as the model, context use and working directory. It is the same in both layouts.
_Avoid_: footer, hints row, context panel, bottom bar

**Inline layout**:
The TUI layout that prints into the terminal's own scrollback and redraws only the rows under it.

**Fullscreen layout**:
The TUI layout that takes the terminal's alternate screen and scrolls the transcript itself.
