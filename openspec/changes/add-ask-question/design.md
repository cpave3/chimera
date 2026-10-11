## Context

A permission request already suspends a tool call until a client answers:
the agent keeps a map of pending requests, emits `permission_request`, and
the session snapshot (`GET /v1/sessions/:id`) carries the pending ones, so a
client that connects again shows them. `request_user_input` is different: it
ends the run.

## Goals / Non-Goals

**Goals:**

- A small, fixed shape that a small model can fill in correctly.
- The same lifecycle as a permission request, so clients need one pattern.

**Non-Goals:**

- Multi-page forms, back navigation, dependent questions.
- Questions from a subagent or from a headless session. The user of those is
  the parent agent or a program.

## Decisions

### D1. Shape

```json
{ "questions": [ { "question": "Which test runner?", "header": "Runner",
    "options": [ { "label": "vitest", "description": "already in the repo" },
                 { "label": "jest" } ] } ] }
```

One to four questions; two to four options each; `header` is an optional
short label. The user may always type an answer instead of picking an
option, so the tool has no "other" option of its own. The result has one
entry for each question, in order: `{ question, answer, custom }`, where
`custom` is true for a typed answer.

### D2. Lifecycle mirrors permissions

`Agent.askQuestions(request)` stores the request, emits `question_request`,
and returns a promise. `Agent.resolveQuestion(id, resolution)` settles it and
emits `question_resolved`. `pendingQuestionRequests()` feeds the session
snapshot. An interrupt of the run cancels every pending question, so the
tool call ends and the run can stop.

### D3. Cancel

The user can dismiss the dialog (`Esc`). The tool then returns `{ status:
"cancelled" }` with a note that the user chose not to answer; the model
decides how to go on. This is not an error: the run continues.

### D4. No user

The tool is built with a `user` flag. The interactive command of a top-level
session sets it. `chimera run`, `chimera serve` and subagents do not; there
the tool returns `{ status: "unavailable" }` at once with a note that tells
the model to state its assumption and continue. Alternative: leave the tool
out of those sessions. Rejected: a prompt or a skill that names the tool
would then fail in a way the model cannot explain.

### D5. TUI

The dialog shows one question at a time with its options as a list (arrow
keys, digits, Enter), plus a last row "type your own answer" that turns into
a text field. Answering the last question submits all answers. It sits in
the same place as the permission prompt; a permission prompt that arrives at
the same time shows first, since it blocks a tool that is already running.

## Risks / Trade-offs

- [The model asks too much] → the tool description says to ask only when the
  answer changes what gets built and cannot be found in the repository.
- [A question waits forever] → it waits for the user as a permission prompt
  does; `Esc` on the dialog or an interrupt of the run ends it.
