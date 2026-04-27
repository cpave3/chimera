## Context

The TUI prompt input today is the simplest possible state machine: a `string`
plus a `useRef` mirror, mutated by `useInput` in `packages/tui/src/App.tsx`
(`App.tsx:108`, `App.tsx:154-161`, `App.tsx:394-508`). `Backspace` strips the
last char; `Enter` submits; printable chars append; there is no cursor and
no notion of multi-line content. It renders as a single `<Text>` with a
trailing inverse-space "cursor" (`App.tsx:1307-1320`).

Two facts shape the design:

1. **Ink handles input via the parent terminal's stdin** — including the
   custom stream wired up in `mount.tsx` for SGR mouse support. Anything we
   spawn that needs the TTY (an editor) must take stdin/stdout/stderr away
   from Ink, run, and hand them back, all without leaving the terminal in
   raw mode or with mouse-tracking enabled.
2. **Terminals don't agree on what `Shift+Enter` looks like.** In legacy
   modes most terminals send the same byte (`\r` or `\n`) for `Enter`,
   `Shift+Enter`, and `Ctrl+M`. Only kitty keyboard protocol, iTerm2's
   "report modifiers" mode, and xterm `modifyOtherKeys=2` reliably
   distinguish them, and Ink's `useInput` doesn't surface those today
   (it parses the legacy keypress vocabulary). So the **portable**
   newline trigger has to be something Ink already gives us; modifier-Enter
   is the bonus path.

The change is small in surface area but the buffer/cursor abstraction is
worth lifting out of `App.tsx` so it can be unit-tested without Ink.

## Goals / Non-Goals

**Goals:**

- Type-and-edit a multi-paragraph prompt directly in the TUI without
  premature submission.
- A documented, terminal-portable newline keybinding (`\` then `Enter`)
  that works everywhere Chimera's TUI runs today.
- Best-effort modifier-Enter (`Shift+Enter`, `Alt+Enter`) for terminals
  that distinguish them, with no regression on terminals that don't.
- `Ctrl+G` hand-off to `$EDITOR` with the current buffer pre-loaded; on
  save+close the editor's contents replace the buffer.
- Caret-style cursor that can be moved within the buffer with arrow keys,
  `Home`/`End`, `Ctrl+A`/`Ctrl+E`, and across line boundaries.
- Preserve every existing prompt behavior: history recall on bare
  `Up`/`Down` from an empty buffer, `Tab`/menu completion on `/...`,
  `Ctrl+C` interrupt/exit, `Ctrl+D` exit.

**Non-Goals:**

- Full text-editor semantics: no word-wise motions (`Alt+B`/`Alt+F`), no
  selection/region, no kill ring, no undo/redo. (Easy follow-ups; they
  belong in a separate change once people use this.)
- Syntax highlighting or markdown preview inside the prompt.
- IME / composition support beyond what Ink's `useInput` already passes
  through.
- Soft-wrap-aware vertical motion across visually wrapped lines: `Up`/
  `Down` move between **logical** lines (separated by `\n`), not visual
  rows produced by terminal wrapping. Documented as a known limitation.
- Mouse-driven cursor placement.
- Sharing the editor handoff with anything other than the prompt
  (e.g., editing scrollback, editing config files).

## Decisions

### 1. Buffer model: `{ text: string, cursor: number }` with logical-line helpers

A single string with a `\n`-aware cursor is simpler than a list-of-lines
representation and matches how the rest of the codebase already passes
prompts around (the wire format is a flat `string`). All operations are
pure functions on `MultilineBuffer`:

```ts
type MultilineBuffer = { text: string; cursor: number };

insertChar(buf, ch): MultilineBuffer
insertNewline(buf): MultilineBuffer
backspace(buf): MultilineBuffer            // delete char before cursor
deleteForward(buf): MultilineBuffer        // delete char at cursor
moveLeft(buf) / moveRight(buf)
moveUp(buf) / moveDown(buf)                // logical-line motion, sticky col
moveLineStart(buf) / moveLineEnd(buf)
replaceAll(buf, text): MultilineBuffer     // editor handoff round-trip
```

`moveUp`/`moveDown` track a "sticky column" across moves so going up from
column 12 then back down lands at column 12 again (standard editor UX).
We hold that column on a `useRef` outside the buffer state — keeping it
inside would force every horizontal-motion call to also clear it, which
is more invasive.

**Alternative considered:** array-of-lines (`{ lines: string[]; row, col }`).
Rejected because `text.split('\n')` and `text.indexOf('\n', cursor)` are
trivial and the conversion noise at the wire boundary outweighs the
slightly cleaner internal API. Performance is irrelevant at prompt size.

### 2. Newline triggers: portable + modifier (`\<Enter>` is canonical)

`Enter` reaches `useInput` as `key.return === true`. To pick a portable
"insert newline" trigger we need a two-keystroke sequence the terminal
**always** delivers verbatim. `\` followed by `Enter` is ideal: backslash
is a printable ASCII char, Enter is a key event, and no terminal modifies
either of them. The handler logic:

```
on Enter:
  if buffer ends with '\' (immediately before cursor) and cursor is at end:
     replace the trailing '\' with '\n', move cursor to after the '\n'
  else if cursor is in the middle of the text and the char before cursor is '\':
     same as above, locally
  else:
     submit
```

This means a literal trailing backslash followed by Enter cannot be
submitted — the same trade Claude Code makes. Users who need a literal
trailing `\` can use `Ctrl+G` to edit in `$EDITOR`, or insert a space
after the `\` before pressing Enter.

For `Shift+Enter` and `Alt+Enter`, Ink's `useInput` exposes `key.shift`
and `key.meta` (Alt = meta on most setups) on the same event as
`key.return`. We accept either as an unconditional newline. On terminals
that don't differentiate, the shift/meta flag is simply false and the
event behaves as a plain Enter — no regression.

**Alternative considered:** `Ctrl+J` (linefeed) as the newline trigger.
Rejected because most readers don't know it, and some shells map it for
their own purposes. Keeping `\<Enter>` as the documented form gives users
a single answer.

### 3. `Ctrl+G` handoff to `$EDITOR`

Chosen binding: `Ctrl+G` matches the user's request and is unused
elsewhere in the TUI. (`Ctrl+X Ctrl+E` would conflict with Ctrl+X being a
common single-key binding in nano-style editors; we pick the simpler
single chord.)

Resolution order: `$VISUAL` → `$EDITOR` → `vi`. Both `$VISUAL` and
`$EDITOR` are honored as written (so users can pass arguments, e.g.
`EDITOR="code -w"`); the first non-empty one wins. We split on whitespace
the same way `git` does for these vars (simple shell-like split, no full
shell evaluation) — sufficient for `code -w`, `nvim`, `vim -p`, etc.

The handoff sequence:

```
1. Snapshot buffer text to a temp file:
     <os.tmpdir>/chimera-prompt-<pid>-<rand>.md
   (`.md` so editors enable markdown highlighting; users frequently
    paste markdown-formatted prompts.)
2. Suspend Ink:
     - call `unmount()` on Ink's instance OR (preferred) hide the cursor,
       leave Ink mounted but pause its rendering by calling
       `instance.clear()` and stopping the input listener.
     - The cleanest approach in Ink 7 is `useApp().exit()`-equivalent for
       a paused state: we don't have one, so we use `app.exit()`-style
       teardown for the editor lifetime is too destructive. Instead:
         a) tell our custom stdin (mouse.ts) to detach,
         b) `process.stdin.setRawMode(false)`,
         c) call `instance.clear()` on the Ink render handle,
         d) write the alt-screen exit sequence if we entered it
            (Ink doesn't, but mouse.ts enables SGR mouse mode — disable
             it: `process.stdout.write('\x1b[?1006l\x1b[?1003l')`).
3. Spawn the editor with stdio: 'inherit' and await its exit.
4. Re-attach: re-enable raw mode, re-enable mouse mode if it was on,
   re-attach the custom stdin, force a re-render.
5. Read the temp file. If it differs from the snapshot, replace the
   buffer with its contents (strip a single trailing newline). If the
   editor exited non-zero or the file was deleted, leave the buffer
   alone and emit a scrollback info line.
6. Always unlink the temp file in a `finally`.
```

The pause/resume helpers live in a new module
`packages/tui/src/input/external-editor.ts` so the messy stdio dance
stays out of `App.tsx`. The Ink render handle (`instance` from
`render(...)`) is already created in `mount.tsx` and is passed down to
`App` via props alongside the existing custom-stdin reference, so the
editor module can call its `clear()` and the mouse-mode toggles
directly.

**Alternative considered:** unmount Ink, run the editor, remount fresh
(react-text-editor style). Rejected because remounting loses `App`'s
React state (scrollback, history, queue, session refs). Keeping Ink
mounted but quiescent is a small amount of plumbing for a much better
UX.

**Alternative considered:** use the `external-editor` npm package.
Rejected to avoid a new dependency for ~50 lines of code; we already
own the stdin plumbing it would wrap.

### 4. Cursor rendering

The current renderer ends with `<Text inverse> </Text>` after the buffer
text — a fake "cursor at end" effect. For multi-line, we render the
buffer split into lines and place an inverse cell at the cursor's
column on the cursor's line:

```
line 0 chars [0..cursorCol] + <inverse>X</inverse> + line 0 chars [cursorCol+1..]
line 1
...
```

Where `X` is either the char at the cursor (so the cursor "covers" it,
matching standard terminal behavior) or a space if the cursor is at the
end of the line. Each line gets its own `<Text>` inside a vertical
`<Box>`, prefixed by the existing `> ` only on the first line; subsequent
lines get two spaces of alignment so the text column lines up.

Heights are not capped: a 30-line buffer renders 30 rows, pushing the
status bars up. Soft-wrapping past terminal width is left to Ink's
default behavior (which wraps without breaking the cursor's logical
position).

### 5. History recall preserved, but only when buffer is empty

The existing rule (`App.tsx:475-485`) is: bare `Up`/`Down` with empty
input cycles history. The new rule keeps that exact predicate: only when
`buffer.text === ''` do `Up`/`Down` recall history; otherwise they move
the cursor by line. Recalling a multi-line entry from history places the
cursor at the end of the recalled text (matching how `Up` lands today).

### 6. Submission still trims and strips, but preserves embedded `\n`

`handleSubmit` already calls `latestInput` directly. We keep the same
flow: on plain `Enter`, take `buffer.text`, push it to history, send it.
The agent already handles multi-line user messages — no protocol work.

## Risks / Trade-offs

- **[Trailing-backslash messages can't be submitted as-is]** A message
  whose intended last character is `\` will be interpreted as the newline
  trigger. → Mitigation: `Ctrl+G` (edit in `$EDITOR`) always works;
  documented in the hint line and `README.md`.

- **[Editor handoff leaves the terminal in a bad state on crash]** If the
  editor segfaults or Ink's resume path throws, raw mode / mouse mode may
  not be restored. → Mitigation: wrap restore logic in `finally` blocks,
  and on uncaught failure write the deterministic restore sequence
  (`\x1b[?1006l\x1b[?1003l`, raw-mode off via
  `process.stdin.setRawMode(false)`, then re-mount Ink). Worst case the
  user types `reset<Enter>` — same as any TUI crash.

- **[Modifier-Enter detection is terminal-dependent]** `Shift+Enter`
  works in some terminals and not others. → Mitigation: documented as
  best-effort in the hint line and proposal; `\<Enter>` is the canonical
  trigger that always works.

- **[Long buffers consume render rows]** A 50-line draft pushes the
  status bars off-screen on small terminals. → Mitigation: acceptable;
  the same constraint applies to scrollback. Could later add a
  scrollable input region if it becomes a real complaint.

- **[Cursor column desync with wide chars / emoji]** Logical char
  position vs. visual column drifts for emoji and CJK. → Mitigation:
  use `string-width` (already in the dep tree via Ink) for column math
  in `moveUp`/`moveDown` sticky-column calculations. Out-of-scope for
  v1 if it adds complexity; document as known.

- **[`process.stdin` re-enter races]** Re-attaching the custom stdin
  while child process bytes are still in the pipe could deliver partial
  escape sequences. → Mitigation: drain stdin (`stdin.read()` until
  null) immediately after the editor exits, before re-arming Ink.

## Migration Plan

No data migration. The change is additive at the TUI layer; no settings
or session-format updates. Rollout is just shipping the new TUI
build. Rollback is reverting the package — no persisted state depends
on the new behavior.

## Open Questions

- **None blocking.** One nice-to-have: should `Ctrl+G` be configurable
  via `~/.chimera/config.json` (`tui.editorKeybinding`)? Defer until
  someone asks; the hard-coded chord is fine for v1 and matches how
  other TUI bindings live in this codebase.
