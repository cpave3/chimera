## ADDED Requirements

### Requirement: Question UI is rendered as a modal overlay

While a question is pending, the TUI SHALL render a `QuestionModal` overlay above the scrollback. The main composer input SHALL be disabled while the modal is active.

#### Scenario: Modal mounts on `question_request`

- **WHEN** a `question_request` event is received
- **THEN** the `QuestionModal` SHALL render above existing scrollback
- **AND** the composer input SHALL not accept keystrokes until the modal closes

#### Scenario: Scrollback summary persists after resolution

- **WHEN** the question is resolved (answered, cancelled, or timed out)
- **THEN** the modal SHALL unmount
- **AND** the scrollback entry for the tool call SHALL show a compact summary (the answers, "cancelled", or "timed out")

### Requirement: Arrow keys navigate options

Within a question, ↑ and ↓ SHALL move focus between options.

#### Scenario: User navigates options with arrow keys

- **WHEN** a question with 4 options is displayed
- **AND** the user presses ↓ three times
- **THEN** focus SHALL be on the fourth option
- **WHEN** the user presses ↑ twice
- **THEN** focus SHALL be on the second option

### Requirement: Space toggles selection; Enter submits the form

Space SHALL toggle the focused option's selection state. For single-select, toggling a different option deselects the previously selected one. For multi-select, Space toggles each option independently. Enter SHALL submit the entire form.

#### Scenario: Single-select selection

- **WHEN** option 2 is focused in a single-select question
- **AND** the user presses Space
- **THEN** option 2 SHALL be selected
- **WHEN** the user navigates to option 3 and presses Space
- **THEN** option 3 SHALL be selected
- **AND** option 2 SHALL no longer be selected

#### Scenario: Multi-select selection

- **WHEN** the user navigates to option 1 and presses Space
- **AND** then navigates to option 3 and presses Space
- **AND** then navigates back to option 1 and presses Space
- **THEN** only option 3 SHALL be selected
- **WHEN** the user presses Enter
- **THEN** the form SHALL be submitted with `[option-3-value]` for that question

### Requirement: Free-text "Other…" opens a text input and is exclusive

When `allowFreeText: true`, an "Other…" entry SHALL appear after the options. Selecting it SHALL open a text input. Submitting non-empty free text SHALL clear any previously selected options for that question.

#### Scenario: User enters custom text

- **WHEN** a question with `allowFreeText: true` is displayed
- **AND** the user navigates to and selects "Other…"
- **THEN** a text input SHALL appear
- **WHEN** the user types "custom answer" and confirms within the modal
- **THEN** that question's pending answer SHALL be `"__free_text__:custom answer"`
- **AND** any previously toggled options for that question SHALL be cleared

### Requirement: Tab navigates between questions in a multi-question form

In a multi-question form, Tab SHALL move focus to the next question and Shift+Tab SHALL move it to the previous question. Option focus SHALL be preserved per question across navigation.

#### Scenario: Tab moves between questions

- **WHEN** a 3-question form is displayed and the user is on question 1
- **AND** the user presses Tab
- **THEN** focus SHALL move to question 2
- **WHEN** the user presses Shift+Tab
- **THEN** focus SHALL return to question 1

### Requirement: User can navigate back and modify previous answers before submit

In a multi-question form, the user SHALL be able to navigate to a previously answered question and change its answer. Modified answers SHALL be the values used on submit.

#### Scenario: User edits a prior answer

- **WHEN** the user has selected `"A"` for question 1 and is now on question 2
- **AND** the user presses Shift+Tab to return to question 1
- **AND** changes the selection to `"B"`
- **AND** Tabs forward and presses Enter to submit
- **THEN** the submitted answer for question 1 SHALL be `["B"]`

### Requirement: Escape cancels the entire form

Pressing Escape while the modal is active SHALL cancel the question (no answers submitted) and unmount the modal.

#### Scenario: Cancellation

- **WHEN** the user presses Escape with a partially answered form
- **THEN** the client SHALL call `cancelQuestion(requestId)`
- **AND** the modal SHALL unmount
- **AND** the tool SHALL resolve with `cancelled: true`

### Requirement: Visual indicators distinguish state

The modal SHALL provide clear visual indication of:
- the focused option (highlighted),
- selected options (filled radio for single-select, checked box for multi-select),
- unselected options (empty marker),
- the current question position in a multi-question form (e.g., "Question 2 of 3").

#### Scenario: Visual states are distinct

- **WHEN** a multi-question form is displayed
- **THEN** the focused option SHALL be visually distinct from unfocused options
- **AND** selected options SHALL be visually distinct from unselected
- **AND** a step indicator SHALL show current and total question counts

### Requirement: Enter submits only when every required answer is set

Enter SHALL only submit the form when every question has at least one selected option or non-empty free-text answer. Otherwise the modal SHALL display a brief inline message indicating which question is missing an answer.

#### Scenario: Submit blocked by missing answer

- **WHEN** the user has answered question 1 but not question 2
- **AND** presses Enter
- **THEN** the form SHALL NOT be submitted
- **AND** an inline message SHALL indicate question 2 needs an answer

#### Scenario: Submit succeeds when all answered

- **WHEN** every question has at least one answer
- **AND** the user presses Enter
- **THEN** the form SHALL be submitted as a single response containing all answers in question order
