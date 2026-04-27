## MODIFIED Requirements

### Requirement: Keybindings

The TUI SHALL honor:

- `Enter` — submit the current input, unless the buffer ends with a single
  unescaped backslash immediately before the cursor, in which case the
  backslash SHALL be replaced with a newline character (`\n`) and the
  cursor SHALL advance past the newline. The input is NOT submitted.
- `Shift+Enter` — insert a newline into the input at the cursor without
  submitting (multi-line composition). Best-effort: terminals that do not
  distinguish `Shift+Enter` from `Enter` will treat the keystroke as
  `Enter`.
- `Alt+Enter` (also reported as `Option+Enter` / `Esc Enter`) — equivalent
  to `Shift+Enter`: insert a newline at the cursor without submitting.
- `Ctrl+G` — open the user's external editor on the current buffer. See
  the "External editor handoff" requirement.
- `Ctrl+C` — if a run is in progress, call `client.interrupt(sessionId)`;
  a second `Ctrl+C` within 2 seconds SHALL exit the process.
- `Ctrl+D` — exit the process cleanly.
- `Up` / `Down` when the input buffer is empty — navigate input history
  (persisted per-session in memory for MVP).
- `Up` / `Down` when the input buffer is non-empty — move the cursor up
  or down by one logical line (separated by `\n`), preserving the user's
  sticky column where possible. They SHALL NOT recall history while the
  buffer is non-empty.
- `Left` / `Right` — move the cursor one character left or right,
  crossing line boundaries.
- `Home` / `Ctrl+A` — move the cursor to the start of the current logical
  line.
- `End` / `Ctrl+E` — move the cursor to the end of the current logical
  line.
- `Backspace` — delete the character immediately before the cursor,
  joining lines if the deleted character is `\n`.
- `Delete` — delete the character at the cursor, joining lines if the
  deleted character is `\n`.
- `PgUp` / `PgDn` — scroll the scrollback region.
- `Tab` on partial `/` input — autocomplete built-in slash command names.

#### Scenario: Double Ctrl+C exits

- **WHEN** a user presses `Ctrl+C` while no run is active and then presses
  `Ctrl+C` again within 2 seconds
- **THEN** the process SHALL exit cleanly (zero status for a normal exit,
  130 if propagating SIGINT)

#### Scenario: Backslash-Enter inserts a newline

- **WHEN** the input buffer contains `hello\` with the cursor at the end
  and the user presses `Enter`
- **THEN** the buffer SHALL become `hello\n` (the trailing `\` is
  replaced by a newline) with the cursor positioned at the start of the
  new second line, and the message SHALL NOT be submitted

#### Scenario: Plain Enter submits when buffer does not end with backslash

- **WHEN** the input buffer contains `hello world` and the user presses
  `Enter`
- **THEN** the message `hello world` SHALL be submitted via
  `handleSubmit` and the buffer SHALL be cleared

#### Scenario: Shift+Enter inserts a newline mid-buffer

- **WHEN** the input buffer is `foobar` with the cursor between the `o`
  and the `b` (offset 3), the running terminal differentiates
  `Shift+Enter` from `Enter`, and the user presses `Shift+Enter`
- **THEN** the buffer SHALL become `foo\nbar` with the cursor at the start
  of the second line (offset 4), and the message SHALL NOT be submitted

#### Scenario: Up arrow navigates within a multi-line buffer instead of history

- **WHEN** the input buffer is `line1\nline2` with the cursor at the end
  (on line 2) and the user presses `Up`
- **THEN** the cursor SHALL move to column 5 (the end of `line1`), no
  history recall SHALL occur, and the buffer text SHALL be unchanged

#### Scenario: Up arrow recalls history when buffer is empty

- **WHEN** the input buffer is empty and the user presses `Up`
- **THEN** the most recently submitted message SHALL be loaded into the
  buffer with the cursor positioned at the end of the recalled text

## ADDED Requirements

### Requirement: Multi-line input buffer

The TUI prompt SHALL maintain its input as a buffer that supports embedded
newline characters (`\n`) and a movable cursor. The buffer SHALL render
across as many display rows as it contains logical lines. The first line
SHALL be prefixed with `> ` and subsequent lines SHALL be prefixed with
two spaces of alignment so that the text columns align.

The cursor SHALL be visually rendered as an inverse-video cell at its
current position (or a trailing inverse space when positioned at the end
of a line). The cursor position SHALL be updated synchronously with every
keystroke that modifies it.

When the buffer is submitted (plain `Enter` with the trailing-backslash
exception), the full buffer text including any embedded `\n` characters
SHALL be passed to `handleSubmit` and pushed onto the history stack as a
single entry.

#### Scenario: Multi-line buffer renders on multiple rows

- **WHEN** the buffer contains `alpha\nbeta\ngamma`
- **THEN** the prompt region SHALL render three rows: `> alpha`,
  `  beta`, `  gamma`

#### Scenario: Multi-line message reaches the agent intact

- **WHEN** the buffer contains `first paragraph\n\nsecond paragraph` and
  the user presses `Enter` (with no trailing backslash)
- **THEN** the message sent through `client.send` SHALL be exactly
  `first paragraph\n\nsecond paragraph`, preserving both newlines

#### Scenario: Cursor-aware backspace joins lines

- **WHEN** the buffer is `hello\nworld` with the cursor at offset 6 (the
  start of `world`) and the user presses `Backspace`
- **THEN** the buffer SHALL become `helloworld` with the cursor at
  offset 5

### Requirement: External editor handoff

Pressing `Ctrl+G` SHALL open the user's external editor on a temporary
file pre-populated with the current buffer text. The editor command SHALL
be resolved as the first non-empty value in this order: `$VISUAL`,
`$EDITOR`, `vi`. The resolved command MAY include arguments; tokens are
split on ASCII whitespace (no shell evaluation).

While the editor is running, the TUI SHALL pause its input handling, the
spawned editor SHALL inherit the terminal's stdin, stdout, and stderr,
and any terminal modes set by the TUI (raw mode, mouse tracking) SHALL be
disabled before the editor starts and restored after it exits.

When the editor exits with status `0`, the buffer text SHALL be replaced
by the file's contents with at most one trailing newline stripped, and
the cursor SHALL be positioned at the end of the new buffer. When the
editor exits with non-zero status, or the temporary file is missing or
unreadable on return, the buffer SHALL be left unchanged and a single
info entry SHALL be appended to the scrollback explaining the failure.
The temporary file SHALL be unlinked unconditionally after the editor
exits.

#### Scenario: Editor populates from current buffer and applies edits

- **WHEN** the buffer contains `draft text` and the user presses
  `Ctrl+G`, the editor opens with that text, the user replaces it with
  `final text\nwith two lines`, saves, and exits with status 0
- **THEN** after the editor closes the buffer SHALL be
  `final text\nwith two lines` with the cursor at the end of the
  buffer

#### Scenario: Non-zero editor exit leaves buffer untouched

- **WHEN** the buffer contains `keep me` and the user presses `Ctrl+G`,
  but the editor exits with status `1` without saving
- **THEN** the buffer SHALL still contain `keep me` and a scrollback
  info entry SHALL note that the editor exited non-zero

#### Scenario: Missing editor falls back to vi

- **WHEN** neither `$VISUAL` nor `$EDITOR` is set in the environment and
  the user presses `Ctrl+G`
- **THEN** the TUI SHALL spawn `vi` with the temp file as its argument

#### Scenario: Terminal modes are restored after editor exits

- **WHEN** the user presses `Ctrl+G` and the editor exits (regardless of
  exit status)
- **THEN** the TUI SHALL re-enable raw mode on stdin, re-enable mouse
  tracking if it was active before the handoff, and re-render its UI on
  the next animation frame
