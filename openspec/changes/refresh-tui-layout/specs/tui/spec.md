## ADDED Requirements

### Requirement: Single status row
The TUI SHALL show one status row below the prompt with the mode, the model, the context use as a percentage, the cached share when the provider reports one, and the sandbox mode when it is not `off`. The TUI SHALL NOT show a permanent row of key hints.

#### Scenario: Idle session
- **WHEN** the TUI is idle with a known context window
- **THEN** the bottom of the screen has exactly one status row, and it names the mode and the model

### Requirement: Help panel
On an empty prompt, `?` SHALL toggle a panel that lists the key bindings. Any other key SHALL close it.

#### Scenario: Open and close
- **WHEN** the user presses `?` on an empty prompt, then `Esc`
- **THEN** the panel with the key bindings appears, then disappears

### Requirement: Activity line
While a run is active the TUI SHALL show one line that states what the agent is doing, the elapsed time of the run, and the key that interrupts it. The line SHALL name the running tool call when one is in flight, and SHALL say when the run waits for approval, compacts, or waits to retry a provider error.

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
`Ctrl+T` SHALL open a view of the whole session on the alternate screen in which every tool call has its own line and its full body. `q` or `Esc` SHALL return to the normal screen with the scrollback unchanged.

#### Scenario: Open the transcript
- **WHEN** the user presses `Ctrl+T` after a run that grouped three reads
- **THEN** the view lists the three reads individually

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
