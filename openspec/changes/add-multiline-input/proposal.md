## Why

The TUI prompt is single-line: every `Enter` submits, so users can't draft a
multi-paragraph message, paste structured snippets without them sending
prematurely, or compose long instructions in their preferred editor. This is a
papercut for any non-trivial prompt and pushes users to write messages in a
separate window and paste them in (often mid-paste, an embedded newline fires
a half-finished submit). Claude Code, OpenCode, and most TUI peers solve this
with `\<Enter>` / `Shift+Enter` for soft newlines and `Ctrl+G` (or `Ctrl+X
Ctrl+E`-style) handoff to `$EDITOR`; Chimera should match.

## What Changes

- The prompt buffer becomes multi-line: it stores `\n` characters and renders
  across as many rows as it has lines.
- New newline triggers (do **not** submit; insert a `\n` at the cursor):
  - `\` immediately followed by `Enter` — the trailing backslash is consumed
    and replaced with a newline (the documented, terminal-portable trigger).
  - `Shift+Enter` — best-effort; works on terminals that distinguish it
    (kitty keyboard protocol, iTerm2, modern xterm with `modifyOtherKeys`).
    Falls back gracefully on terminals that don't (the `\<Enter>` form
    always works).
  - `Alt+Enter` / `Option+Enter` — also accepted, since several terminals
    emit `Esc Enter` for it and it's a common muscle-memory alternative.
- Plain `Enter` continues to submit the current buffer.
- `Ctrl+G` opens the user's `$EDITOR` (then `$VISUAL`, then `vi` as a
  fallback) on a temp file pre-populated with the current buffer; on
  successful close, the file's contents replace the buffer (trailing newline
  stripped). On editor non-zero exit or empty save, the buffer is left
  unchanged. While the editor is open, Ink rendering is suspended and the
  child inherits the terminal's stdio so full-screen editors (vim, nano,
  helix) work normally.
- Input rendering gains a visible cursor that can move within the buffer:
  `Left`/`Right` move by char, `Up`/`Down` move by visual line (clamped to
  line length), `Home`/`End` jump to line start/end, `Ctrl+A`/`Ctrl+E`
  mirror them. Existing history-recall semantics for bare `Up`/`Down` (when
  the buffer is empty) are preserved; once the buffer is non-empty,
  `Up`/`Down` navigate within it instead of recalling history.
- `Backspace` and `Delete` operate at the cursor (not just at end-of-buffer
  as today) and correctly delete across line boundaries.
- The bottom hint line gains `\<Enter> newline · Ctrl+G editor` so the
  feature is discoverable.

## Capabilities

### New Capabilities

None — this extends an existing capability rather than introducing a new one.

### Modified Capabilities

- `tui`: prompt input gains multi-line buffer semantics, cursor movement,
  newline-trigger key bindings, and a `Ctrl+G` external-editor escape hatch.

## Impact

- **Prerequisites**: none beyond the current `tui` package.
- **Code changes**: confined to `packages/tui`. The buffer state in
  `App.tsx` (currently `input: string` plus `inputRef`) is replaced by a
  small `MultilineBuffer` model (text + cursor offset) extracted into
  `packages/tui/src/input/buffer.ts` for unit testing without Ink. The
  `useInput` handler in `App.tsx` is refactored to dispatch buffer
  operations. A new `packages/tui/src/input/external-editor.ts` module owns
  the `Ctrl+G` flow (suspend stdin/stdout, spawn editor, restore). The
  prompt's render block (`App.tsx:1307-1320`) is updated to show multiple
  lines and a positional cursor.
- **No protocol or server changes.** Submitted messages still flow as a
  single string with embedded `\n`s, which the agent already accepts; no
  changes to `@chimera/core`, `@chimera/server`, or `@chimera/client`.
- **Tests**: new `packages/tui/test/input-buffer.test.ts` (pure-unit
  coverage of the buffer model) and new cases in
  `packages/tui/test/slash-dispatch.test.tsx` for the Ink-level keybindings
  (`\<Enter>`, `Shift+Enter`, `Ctrl+G` with a stub `$EDITOR`).
- **Docs**: `docs/MODES.md` is unaffected; the existing TUI hint line
  inside `App.tsx` is updated and a short blurb is added to `README.md`'s
  TUI section.
- **Risk**: low. The `Ctrl+G` editor handoff is the only piece that touches
  process control; failures (editor not found, non-zero exit, user
  interrupt) leave the buffer intact and emit an info entry to the
  scrollback.
