# Chimera

A single-agent coding tool with a terminal UI, a server and a headless mode.

## TUI

**Status line**:
The configurable bar at the bottom of the TUI that shows session facts such as the model, context use and working directory. It is the same in both layouts.
_Avoid_: footer, hints row, context panel, bottom bar

**Label column**:
The narrow right-aligned column at the left of the transcript that names each entry (`you`, `think`, `read`, `bash`, ...). Assistant text has no label.

**Prompt box**:
The bordered box the user types in. Its top border shows the mode and the activity; its bottom border holds the status line.
_Avoid_: input box, editor

**Inline layout**:
The TUI layout that prints into the terminal's own scrollback and redraws only the rows under it.

**Fullscreen layout**:
The TUI layout that takes the terminal's alternate screen and scrolls the transcript itself.
