## ADDED Requirements

### Requirement: Two-row footer
The TUI SHALL show two rows below the prompt. The first row SHALL show the mode, the model and the sandbox mode on the left, and on the right the context use as a gauge with a percentage, the token counts as used/window, and the cached share when the provider reports one. The second row SHALL show the working directory, the session id and the task count with the task in progress on the left, and key hints for the current state on the right. When a row does not fit the terminal width, the TUI SHALL drop its least important items first and SHALL NOT wrap.

#### Scenario: Idle session
- **WHEN** the TUI is idle with a known context window
- **THEN** the first row names the mode, the model and the sandbox mode, and the second row names the working directory and the session id

#### Scenario: Context use
- **WHEN** the last step used 84,000 of 200,000 tokens and 81% of the prompt was cached
- **THEN** the first row shows a gauge with `42%`, `84k/200k` and `cache 81%`

#### Scenario: Hints follow the state
- **WHEN** a run is active
- **THEN** the second row shows the keys to steer and to interrupt, and not the idle hints

#### Scenario: Narrow terminal
- **WHEN** the terminal is 60 columns wide
- **THEN** no footer row is longer than 60 columns, and the mode and the context percentage are still shown

### Requirement: Start banner
At the top of a session the TUI SHALL print a banner with the version, the model, the working directory, the session id, the mode and the sandbox mode, and the number of skills and commands when any were loaded.

#### Scenario: Session start
- **WHEN** a session starts with 12 skills loaded
- **THEN** the banner names the model, the working directory, the session, the mode, the sandbox mode and `12 skills`

### Requirement: Tool line state
A tool line SHALL start with a glyph for its state: running, returned, or failed. A command that exited non-zero SHALL count as failed. A call that took one second or longer SHALL show its duration.

#### Scenario: Slow failing command
- **WHEN** a `bash` call returns exit code 1 after 8.2 seconds
- **THEN** its line starts with the failed glyph and ends with `8.2s`

### Requirement: Turn summary
When a run ends after at least one model step or tool call, the transcript SHALL end the turn with one line that states the duration, the number of steps and tool calls, the input and output tokens of the run, and the cached share.

#### Scenario: Run with tool calls
- **WHEN** a run of 72 seconds with 2 steps and 2 tool calls ends
- **THEN** the transcript shows a line with `1m 12s`, `2 steps` and `2 tool calls`

#### Scenario: Run that never reached the model
- **WHEN** a run ends with an error before any step
- **THEN** no summary line is added

### Requirement: Help panel
On an empty prompt, `?` SHALL toggle a panel that lists the key bindings. Any other key SHALL close it.

#### Scenario: Open and close
- **WHEN** the user presses `?` on an empty prompt, then `Esc`
- **THEN** the panel with the key bindings appears, then disappears

### Requirement: Activity line
While a run is active the TUI SHALL show one line that states what the agent is doing, the elapsed time of the run, the model step in progress, and the key that interrupts it. The line SHALL name the running tool call when one is in flight, and SHALL say when the run waits for approval, compacts, or waits to retry a provider error.

#### Scenario: Tool in flight
- **WHEN** a `bash` call for `pnpm test` is in flight
- **THEN** the activity line contains `pnpm test`

#### Scenario: Waiting for approval
- **WHEN** a permission request is open
- **THEN** the activity line says the run waits for approval

### Requirement: Transcript markers
User messages SHALL be marked with a glyph instead of the text `you:`. Tool lines SHALL NOT carry bracketed target badges when the target is the host and no sandbox is active.

#### Scenario: User message
- **WHEN** the user sends `fix the test`
- **THEN** the transcript shows the message with the marker and without `you:`

### Requirement: Grouped exploration calls
Consecutive successful `read`, `glob`, `find`, `ls` and `grep` calls SHALL appear in the transcript as one line that states how many files were read and how many searches ran. A failed call, an image read, or any other entry SHALL end the group.

#### Scenario: Four reads and two searches
- **WHEN** the agent reads four files and runs two searches in a row, then edits a file
- **THEN** the transcript has one exploration line that says 4 files and 2 searches, followed by the edit

### Requirement: Transcript view
`Ctrl+T` SHALL open the whole session in a pager (`$PAGER`, else `less`) in which every tool call has its own line and its full output. Leaving the pager SHALL return to the TUI with the scrollback unchanged. When the pager cannot be started, the TUI SHALL say why.

#### Scenario: Open the transcript
- **WHEN** the user presses `Ctrl+T` after a run that grouped three reads
- **THEN** the view lists the three reads individually

#### Scenario: No pager available
- **WHEN** the user presses `Ctrl+T` and the pager command does not exist
- **THEN** the transcript shows a line that names the failure

### Requirement: Task panel
While a run is active and the session has a task list, the TUI SHALL show the tasks with their status above the prompt, at most 6 lines, starting from the task in progress.

#### Scenario: Run with tasks
- **WHEN** a run is active with five tasks, two completed and one in progress
- **THEN** the panel shows the count 2/5 and marks the task in progress

### Requirement: Highlighted code blocks
Fenced code blocks with a known language SHALL be rendered with syntax colors from the theme.

#### Scenario: TypeScript block
- **WHEN** an assistant message has a fenced `ts` block
- **THEN** keywords and strings in it are rendered in the theme's syntax colors

### Requirement: Approval list
The permission prompt SHALL offer its choices as a list. Up and Down SHALL move the selection, Enter SHALL confirm it, a digit SHALL choose that item, and Esc SHALL deny. The letter keys of the previous prompt SHALL keep their meaning.

#### Scenario: Arrow keys
- **WHEN** the user presses Down once and Enter on a permission prompt
- **THEN** the second choice is applied

#### Scenario: Letter key
- **WHEN** the user presses `a`
- **THEN** the request is allowed once

### Requirement: Bounded live region
The region the TUI redraws SHALL stay shorter than the terminal, whatever the number of tasks and queued messages.

#### Scenario: Many tasks on a small terminal
- **WHEN** a run is active on an 80×24 terminal with 20 tasks and 5 queued messages
- **THEN** the redrawn region is shorter than 24 rows
