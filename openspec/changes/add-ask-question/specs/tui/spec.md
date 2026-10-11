## ADDED Requirements

### Requirement: Question dialog
When a question is pending, the TUI SHALL show a dialog with the question, its options as a list, and a row for the user's own answer. Up and Down SHALL move, a digit SHALL pick the option with that number, and Enter SHALL confirm. On the row for the user's own answer, Enter SHALL open a text field. With several questions, the dialog SHALL show them one after the other and say which one is shown, and SHALL send all answers after the last. Esc SHALL dismiss the questions. A question that was pending when the TUI attached SHALL be shown.

#### Scenario: Pick with arrows
- **WHEN** a question with three options is shown and the user presses Down and then Enter
- **THEN** the second option is sent as the answer

#### Scenario: Own answer
- **WHEN** the user moves to the last row, presses Enter, types `use bun test` and presses Enter
- **THEN** `use bun test` is sent as the answer

#### Scenario: Several questions
- **WHEN** two questions are pending in one request and the user answers the first
- **THEN** the dialog shows the second question and says `2 of 2`

#### Scenario: Dismiss
- **WHEN** the user presses Esc
- **THEN** the questions are cancelled and the dialog closes
