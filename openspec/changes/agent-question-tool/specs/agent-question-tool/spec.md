## ADDED Requirements

### Requirement: Agent can ask structured questions via `ask_question`

The system SHALL provide an `ask_question` tool. The tool SHALL accept a `questions` array; each question SHALL have an `id`, a `prompt`, a `type` of `"single"` or `"multi"`, an `options` array, and an optional `allowFreeText` boolean.

#### Scenario: Agent asks a single-select question

- **WHEN** the agent calls `ask_question` with one question whose `type` is `"single"` and three options
- **THEN** the system SHALL present the question to the user with radio-style selection
- **AND** the user SHALL be able to select exactly one option

#### Scenario: Agent asks a multi-select question

- **WHEN** the agent calls `ask_question` with one question whose `type` is `"multi"` and four options
- **THEN** the system SHALL present the question to the user with checkbox-style selection
- **AND** the user SHALL be able to select zero or more options

### Requirement: Question options have value, label, and optional description

Each option SHALL have a `value` (machine-readable string returned to the agent), a `label` (user-facing string), and an optional `description` (secondary explanatory text).

#### Scenario: Question displays labels and descriptions

- **WHEN** a question is presented with options containing labels and descriptions
- **THEN** the user SHALL see the label as the primary text
- **AND** the user SHALL see the description as secondary text when present
- **AND** the response returned to the agent SHALL contain `value`s, not labels

### Requirement: Free-text input is per-question and exclusive

The `ask_question` tool SHALL accept `allowFreeText: boolean` per question. When `true`, the user SHALL be offered an "Other…" affordance that opens a free-text input. Free-text answers SHALL be exclusive of any selected options for that question.

#### Scenario: User submits free-text in a single-select question

- **WHEN** a question has `allowFreeText: true`
- **AND** the user enters "custom answer" via the "Other…" affordance and submits
- **THEN** the response for that question SHALL be `["__free_text__:custom answer"]`

#### Scenario: Free-text replaces option selections in multi-select

- **WHEN** a multi-select question has `allowFreeText: true`
- **AND** the user has previously selected option values `"a"` and `"b"`
- **AND** the user then chooses "Other…" and enters "custom"
- **THEN** the response for that question SHALL be `["__free_text__:custom"]` only
- **AND** the previously selected options SHALL NOT appear in the response

### Requirement: `ask_question` is auto-approved by the permission gate

The `ask_question` tool SHALL run without raising a permission request, regardless of session permission mode.

#### Scenario: Tool runs without permission prompt

- **WHEN** the agent calls `ask_question` in a session whose default mode would otherwise require approval
- **THEN** no `permission_request` event SHALL be emitted for the tool itself
- **AND** the question SHALL be presented immediately

### Requirement: Question is blocking and the session reflects waiting state

While a question is pending, the agent SHALL stop processing further tool calls or messages, and `Session.status` SHALL be `"waiting_for_input"`. On resolution, status SHALL return to `"running"`.

#### Scenario: Status flips during a question

- **WHEN** the agent calls `ask_question`
- **THEN** `Session.status` SHALL transition to `"waiting_for_input"`
- **WHEN** the user submits a response
- **THEN** `Session.status` SHALL transition back to `"running"`
- **AND** the agent SHALL continue processing

### Requirement: Concurrent questions are rejected

If `ask_question` is called while another question from the same session is pending, the second call SHALL reject immediately with a tool error.

#### Scenario: Second question rejected

- **WHEN** a question is pending
- **AND** the agent (or a subagent) calls `ask_question` again in the same session
- **THEN** the tool SHALL fail with an error `"A question is already pending in this session"`

### Requirement: Tool returns a structured JSON response

The tool's return value to the model SHALL be `JSON.stringify({ answers, cancelled?, timedOut? })` where `answers` is an array of arrays of strings, one inner array per question, in the order the questions were asked.

#### Scenario: Single-question single-select response

- **WHEN** the user selects option `"a"` from a single-question single-select call
- **THEN** the tool SHALL return `'{"answers":[["a"]]}'`

#### Scenario: Multi-question response

- **WHEN** the agent asks 3 questions and the user selects `"a"` for q1, `"b"` and `"c"` for q2, and submits free text `"foo"` for q3
- **THEN** the tool SHALL return `'{"answers":[["a"],["b","c"],["__free_text__:foo"]]}'`

### Requirement: Cancellation and timeout are non-error tool results

If the user cancels a question, the tool SHALL return `'{"answers":[],"cancelled":true}'`. If the question is not answered before the timeout (default 5 minutes), the tool SHALL return `'{"answers":[],"timedOut":true}'`. Neither outcome SHALL surface as a tool error.

#### Scenario: User cancellation

- **WHEN** the user cancels a pending question
- **THEN** the tool SHALL resolve (not reject) with `'{"answers":[],"cancelled":true}'`

#### Scenario: Timeout

- **WHEN** a question remains unanswered past the configured timeout
- **THEN** the tool SHALL resolve with `'{"answers":[],"timedOut":true}'`

### Requirement: Agent abort clears pending question

If the agent run is aborted while a question is pending, the pending question SHALL be cleared and the tool's promise SHALL reject with the abort reason. No `question_resolved` event is emitted.

#### Scenario: Abort during pending question

- **WHEN** a question is pending
- **AND** the agent's `AbortSignal` fires
- **THEN** the pending question SHALL be removed from session state
- **AND** the tool's promise SHALL reject with the abort reason

### Requirement: System prompt teaches `ask_question` usage

The system prompt SHALL include guidance on:
- when to ask vs. proceed on assumption (preferring assumptions for low-stakes choices),
- choosing single-select vs. multi-select,
- preferring multi-question forms (≤5) over sequential single asks,
- handling `cancelled` and `timedOut` responses gracefully.

#### Scenario: Agent uses the tool appropriately

- **WHEN** the agent faces a high-stakes ambiguous choice between known options
- **THEN** the agent SHALL call `ask_question` with structured options
- **AND** the agent SHALL NOT ask open-ended "What should I do?" questions in assistant text
