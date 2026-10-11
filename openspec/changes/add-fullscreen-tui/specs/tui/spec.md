## ADDED Requirements

### Requirement: Fullscreen layout
The interactive TUI SHALL by default draw on the terminal's alternate screen and fill it. The left column SHALL hold the transcript, the activity line, open menus and dialogs, the prompt box and a hints row. The right column SHALL hold the context panel. When the session ends the TUI SHALL leave the alternate screen and restore the terminal.

#### Scenario: Start
- **WHEN** the TUI starts on a terminal of 140 columns
- **THEN** the screen shows the transcript and the prompt on the left and the context panel on the right

#### Scenario: Prompt box
- **WHEN** the prompt is empty
- **THEN** the prompt box shows the `›` marker and the placeholder `message chimera`

#### Scenario: Hints row
- **WHEN** the mode is `build` and no run is active
- **THEN** the hints row shows a `BUILD` badge and the keys for mode, commands, files, the panel and help

#### Scenario: Run active
- **WHEN** a run is active
- **THEN** the hints row shows the keys to steer, to queue and to interrupt

### Requirement: Inline layout selection
The TUI SHALL use the inline layout, which prints the transcript into the terminal's own scrollback, when the user asks for it or when the terminal cannot show a fullscreen program. The inline layout SHALL NOT use the alternate screen and SHALL NOT capture the mouse.

#### Scenario: Flag
- **WHEN** the user starts `chimera --inline`
- **THEN** the TUI uses the inline layout

#### Scenario: No terminal
- **WHEN** stdout is not a TTY or `TERM` is `dumb`
- **THEN** the TUI uses the inline layout

### Requirement: Context panel
The context panel SHALL show, from top to bottom: the product name and version; the model, the session id, the sandbox mode and the number of loaded skills and commands; the context use; the plan; the working tree; the other live instances; and the session's token totals. A section with nothing to show SHALL be left out. When the panel is too short for all sections, the sections lower on the panel SHALL be cut first.

#### Scenario: Session facts
- **WHEN** the session runs `manticore/gpt` with the sandbox off and 60 skills and 9 commands loaded
- **THEN** the panel shows `manticore/gpt`, the last eight characters of the session id, `off` and `60 skills · 9 cmds`

#### Scenario: Context use
- **WHEN** the last step used 76,000 of 200,000 tokens
- **THEN** the panel shows `CONTEXT · 76k / 200k` and a bar that is 38% filled

#### Scenario: Context by category
- **WHEN** the server reports the size of the system prompt and the skills index is known
- **THEN** the bar shows system, skills and history as separate segments with a legend

#### Scenario: Plan
- **WHEN** the task list has two completed tasks, one in progress and one pending
- **THEN** the panel shows `PLAN` with `✓` on the completed tasks, `▸` on the task in progress and `○` on the pending task

#### Scenario: Working tree
- **WHEN** the working directory is on branch `yg/json-flag`, one commit ahead, with `list.ts` modified by 18 added and 3 removed lines
- **THEN** the panel shows `WORKTREE`, `yg/json-flag`, `↑1` and `M list.ts` with `+18` and `−3`

#### Scenario: Not a repository
- **WHEN** the working directory is not in a git repository
- **THEN** the panel shows no working tree section

#### Scenario: Peers
- **WHEN** another Chimera instance is live in mode `plan` and idle
- **THEN** the panel shows `PEERS` with that instance, `plan` and `idle`

#### Scenario: Token totals
- **WHEN** the session has used 3,200 input and 640 output tokens
- **THEN** the bottom of the panel shows `↑ 3.2k ↓ 640`

### Requirement: Panel visibility
Ctrl+B SHALL hide and show the context panel. The TUI SHALL hide the panel when the terminal is narrower than 100 columns. While the panel is hidden, the hints row SHALL show the model and the context percentage, and the task list SHALL show above the activity line during a run.

#### Scenario: Toggle
- **WHEN** the user presses Ctrl+B with the panel shown
- **THEN** the panel is hidden and the transcript uses the full width

#### Scenario: Narrow terminal
- **WHEN** the terminal is 80 columns wide
- **THEN** the panel is hidden and the hints row shows the model and the context percentage

### Requirement: Transcript scrolling
In the fullscreen layout the transcript SHALL follow the newest output until the user scrolls. PageUp, PageDown and the mouse wheel SHALL scroll the transcript, also while a permission prompt or a picker is open. While the user is scrolled away from the end, new output SHALL NOT move the visible text, and the hints row SHALL name the key that returns to the newest output. Scrolling to the end or sending a message SHALL follow the newest output again. A burst of scroll events that arrives between two frames SHALL add up.

#### Scenario: Follow
- **WHEN** new output arrives and the user has not scrolled
- **THEN** the newest line is visible

#### Scenario: Page up
- **WHEN** the transcript is longer than its pane and the user presses PageUp
- **THEN** earlier lines are visible and the newest line is not

#### Scenario: Return to the end
- **WHEN** the user has scrolled up and sends a message
- **THEN** the newest line is visible again

#### Scenario: Wheel
- **WHEN** the terminal reports a wheel-up event
- **THEN** the transcript scrolls up by three lines

### Requirement: Long transcripts stay responsive
The fullscreen layout SHALL draw each finished transcript entry once and reuse the result until the width or the theme changes. It SHALL mount a window of the newest finished entries: at most 600 while it follows the newest output, cut back to the newest 300 when that number is passed. A line above the window SHALL say how many earlier entries exist. A scroll up from the top of the window SHALL mount 300 earlier entries and SHALL keep the text on screen in place.

#### Scenario: Long session
- **WHEN** the transcript has 700 entries and the user has not scrolled
- **THEN** the newest 300 entries are mounted, and the line above them says that 400 earlier entries exist

#### Scenario: Scroll up from the top
- **WHEN** the user is at the top of the window and scrolls up
- **THEN** 300 earlier entries are mounted and the entry that was at the top is still on screen

### Requirement: Fullscreen handoff
When the TUI hands the terminal to an editor or a pager from the fullscreen layout, or is suspended, it SHALL leave the alternate screen and stop mouse reports first, and SHALL return to the alternate screen and repaint the whole screen afterwards. When the session ends, its last frame SHALL be empty, so that nothing of the layout is copied to the terminal's main screen.

#### Scenario: Editor returns
- **WHEN** the user presses Ctrl+G, edits the prompt and exits the editor
- **THEN** the fullscreen layout is drawn again with the edited prompt

#### Scenario: Suspend and resume
- **WHEN** the user presses Ctrl+Z and later resumes the process
- **THEN** the shell is shown on the main screen while the process is stopped, and the fullscreen layout is drawn again in full on resume

### Requirement: Transcript line style
A user message SHALL start with `›` and SHALL wrap between words. Assistant text SHALL start with `◆`. A tool line SHALL start with a glyph for its state: `○` running, `●` returned, `✗` failed. Tool lines that follow each other SHALL have no blank line between them. The body of an edit, a patch or a written file SHALL be drawn inside a border. A border on a screen with a painted background SHALL carry that background.

#### Scenario: Tool group
- **WHEN** the model calls `read`, then `grep`, then `edit`
- **THEN** the three tool lines are on consecutive rows

#### Scenario: Assistant text
- **WHEN** the model answers with text
- **THEN** the first line of the answer starts with `◆`

### Requirement: Mouse selection
In the fullscreen layout, a drag with the left mouse button SHALL select text and show the selection as a highlight. When the button is released, the selected text SHALL go to the clipboard, through the system's clipboard tool when one is available and the session is not over SSH, and through the terminal's clipboard sequence (OSC 52) in every case. The TUI SHALL say how many characters were copied. A selection SHALL stay within the screen region it starts in (the transcript column or the context panel). Trailing blanks of a row SHALL NOT be copied, and rows after the first SHALL lose the indent that the first row starts at. A click without a drag SHALL NOT change the clipboard. The highlight SHALL be removed after a short time, and at once on a key press or a scroll.

#### Scenario: Copy from the transcript
- **WHEN** the user drags across `Describe a task to` in the transcript and releases the button
- **THEN** the clipboard holds `Describe a task to`, and the hints row says `copied 18 characters`

#### Scenario: Panel stays out
- **WHEN** the user drags from the transcript to a point over the context panel
- **THEN** the copied text ends at the edge of the transcript column

#### Scenario: Code keeps its shape
- **WHEN** the user selects an indented code block from its first character to its last
- **THEN** the copied lines have the indentation of the code, without the transcript's own indent

#### Scenario: Click
- **WHEN** the user clicks without dragging
- **THEN** nothing is copied

#### Scenario: Mouse left to the terminal
- **WHEN** `tui.mouse` is `false`
- **THEN** the TUI asks for no mouse reports, and the terminal's own selection works

