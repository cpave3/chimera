## Why

When a task has a real fork (two libraries, two places to put a file), the
agent either guesses or stops the whole run with `request_user_input`. Codex
and Claude Code let the model put a short multiple-choice question to the
user and go on in the same step with the answer.

## What Changes

- An `ask_question` tool: one call carries 1 to 4 questions, each with 2 to
  4 options. The user picks an option or types an answer of their own.
- The call waits for the answer. The run goes on in the same step.
- `request_user_input` stays as it is, for a handoff that ends the run.
- The server keeps pending questions, as it keeps pending permission
  requests, so a client that connects again sees them.
  `POST /v1/sessions/:id/questions/:requestId` answers or cancels one.
- The TUI shows the questions in a dialog with arrow keys.
- Where no user can answer (`chimera run`, `chimera serve`, a subagent), the
  tool returns at once and says so; the model then states its assumption and
  goes on.
- This replaces the unstarted `agent-question-tool` change. There are no
  multi-page forms and no back navigation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tool-execution`: the `ask_question` tool.
- `agent-server`: pending questions and the answer endpoint.
- `tui`: the question dialog.

## Impact

- `packages/core`: question types, two events, the agent's pending
  questions.
- `packages/tools`: the tool.
- `packages/server`, `packages/client`: the endpoint and `answerQuestion`.
- `packages/tui`: the dialog and its place in the dialog queue.
- `packages/cli`: the interactive command turns the tool's user on.
