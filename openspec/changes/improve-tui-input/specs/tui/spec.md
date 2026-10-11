## ADDED Requirements

### Requirement: File completion
When the word under the cursor starts with `@` or `#`, the TUI SHALL show a list of files in the working directory that match the rest of the word, at most six rows, best match first. Up and Down SHALL move the selection, Tab or Enter SHALL replace the word with the marker and the selected path followed by a space, and Esc SHALL close the list.

#### Scenario: Pick a file
- **WHEN** the user types `fix @agent` in a project that has `packages/core/src/agent.ts` and presses Tab
- **THEN** the prompt reads `fix @packages/core/src/agent.ts ` and the list is closed

#### Scenario: No match
- **WHEN** the word after `@` matches no file
- **THEN** no list is shown and Enter submits the message

#### Scenario: Close the list
- **WHEN** the user presses Esc while the list is open
- **THEN** the list closes, the prompt keeps its text, and the run is not interrupted

### Requirement: Queue a message for the next turn
During a run, Tab with a non-empty prompt and no open menu SHALL hold the message for the next turn instead of sending it to the current run. The TUI SHALL list queued messages above the prompt. When the run ends, queued messages SHALL be sent as the next turn. Up at an empty prompt SHALL move the newest queued message back into the prompt.

#### Scenario: Queue during a run
- **WHEN** a run is active and the user types `also fix lint` and presses Tab
- **THEN** the message appears in the queue list, the prompt is empty, and nothing is sent to the current run

#### Scenario: Sent after the run
- **WHEN** the run ends with one queued message
- **THEN** that message is sent as the next turn and the queue list is empty

#### Scenario: Take a queued message back
- **WHEN** the queue has two messages and the user presses Up at an empty prompt
- **THEN** the prompt holds the second message and the queue has one

### Requirement: Notifications
When a run ends, a permission request opens, or the agent requests user input, the TUI SHALL notify through the terminal according to the `notifications` setting: `off` sends nothing, `bell` sends a bell, and `auto` sends a bell and an OSC 9 notification only when the terminal is not focused, or, when the terminal does not report focus, for approvals and input requests always and for a finished run only when the run lasted ten seconds or more.

#### Scenario: Unfocused terminal
- **WHEN** the terminal reported that it lost focus and a run ends
- **THEN** a notification is sent

#### Scenario: Focused terminal
- **WHEN** the terminal reported that it has focus and a run ends
- **THEN** no notification is sent

#### Scenario: Notifications off
- **WHEN** `notifications` is `off` and a permission request opens
- **THEN** no notification is sent
