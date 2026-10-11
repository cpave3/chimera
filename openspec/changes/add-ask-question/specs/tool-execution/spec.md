## ADDED Requirements

### Requirement: ask_question tool
Chimera SHALL register an `ask_question` tool. One call SHALL carry 1 to 4 questions, and each question SHALL have 2 to 4 options with a label and an optional description. When a user can answer, the call SHALL wait for the answer, and the run SHALL go on in the same step with a result that has one entry for each question, in order, with the chosen option's label or the text the user typed. A call outside these limits SHALL fail validation without asking the user.

#### Scenario: One question
- **WHEN** the model asks one question with three options and the user picks the second
- **THEN** the tool result has one answer, the label of the second option, and the run continues in the same step

#### Scenario: Four questions
- **WHEN** the model asks four questions and the user answers each
- **THEN** the tool result has four answers in the order of the questions

#### Scenario: Typed answer
- **WHEN** the user types `use bun test` instead of picking an option
- **THEN** the answer is `use bun test` and it is marked as the user's own text

#### Scenario: Too many questions
- **WHEN** the model calls the tool with five questions
- **THEN** the call fails validation and the user is not asked

### Requirement: Cancelled and unavailable questions
When the user dismisses the questions, or the run is interrupted while they wait, the tool SHALL return a result with status `cancelled`, and the run SHALL go on unless it was interrupted. In a session with no user to answer (`chimera run`, `chimera serve`, a subagent), the tool SHALL return at once with status `unavailable` and a note that tells the model to state its assumption and continue.

#### Scenario: Cancel
- **WHEN** the user dismisses the question dialog
- **THEN** the tool result has status `cancelled` and the model's next step runs

#### Scenario: Headless
- **WHEN** the model calls `ask_question` in `chimera run`
- **THEN** the tool returns at once with status `unavailable`, and nothing waits
