# Requesting user input

The always-available `request_user_input` tool lets an agent hand control back to a person when progress genuinely requires information or a manual action.

```json
{
  "request": "Run the migration and paste its output",
  "kind": "action"
}
```

`request` must say exactly what the user needs to provide or do. `kind` is optional and may be `information` or `action`.

## Run lifecycle

Calling the tool returns a normal acknowledgement result and preserves the assistant/tool exchange in session history. Chimera then:

1. lets every sibling tool call already emitted in the same model step settle;
2. emits `user_input_required` with the request;
3. waits for configured `UserInputRequired` hooks;
4. emits `run_finished` with `reason: "waiting_for_input"`; and
5. does not invoke the model again in that run.

Chimera does not cancel sibling calls because they may already have started or produced side effects. The next ordinary user message starts a fresh run and includes the prior handoff exchange in model history.

The tool remains available even when an agent definition or mode restricts other tools. It does not require permission because it performs no host, sandbox, or network operation.

## Clients and one-shot runs

SDK consumers should handle both events:

```ts
for await (const event of client.send(sessionId, response)) {
  if (event.type === 'user_input_required') {
    notifyUser(event.request, event.kind);
  }
  if (event.type === 'run_finished' && event.reason === 'waiting_for_input') {
    markWaiting(sessionId);
  }
}
```

`chimera run` exits with code 0 for this valid handoff and prints the request in text mode. It does not apply a workspace overlay under `--apply-on-success`; overlay application remains limited to `reason: "stop"`.

A child agent's request ends only the child run. The parent receives the nested event and child result with `reason: "waiting_for_input"` and decides how to proceed.

The waiting status is live process state. Session events and conversation history are persisted, but reopening the server loads the session as `idle` rather than reconstructing a pending request.

See [Hooks](hooks.md) for the notification hook payload and discovery paths.

## Asking a question without ending the run

`request_user_input` ends the run. For a choice the agent can act on at once
there is `ask_question`: it puts one to four multiple-choice questions to the
user and the run goes on in the same step with the answers.

```json
{
  "questions": [
    {
      "question": "Which test runner should the new package use?",
      "header": "Runner",
      "options": [
        { "label": "vitest", "description": "already used in this repository" },
        { "label": "node:test" }
      ]
    }
  ]
}
```

Each question has two to four options. The user can pick one or type an
answer of their own, so the model does not add an "other" option. The result
has one entry for each question, in order:

```json
{ "status": "answered",
  "answers": [ { "question": "Which test runner…", "answer": "vitest", "custom": false } ] }
```

| Status | When | What the model does |
| --- | --- | --- |
| `answered` | The user answered every question. | Goes on with the answers. |
| `cancelled` | The user dismissed the dialog (`Esc`), or the run was interrupted. | Goes on with its own best choice and says which, or stops. |
| `unavailable` | No user watches the session: `chimera run`, `chimera serve`, a subagent. | States its assumption and continues. The call does not wait. |

In the TUI the questions show in a dialog, one at a time: `↑`/`↓` and
`Enter`, or the number of an option; the last row opens a text field for an
answer of your own.

### For SDK clients

The lifecycle is the one of a permission request:

1. `question_request { requestId, questions }` arrives on the event stream.
   The tool call stays open.
2. The client answers with `client.answerQuestion(sessionId, requestId,
   resolution)` (`POST /v1/sessions/:id/questions/:requestId`), where
   `resolution` is `{ status: "answered", answers }` or
   `{ status: "cancelled" }`. A question that is not pending answers 409.
3. `question_resolved { requestId, status }` follows, and the run goes on.

`GET /v1/sessions/:id` lists the open questions under `pendingQuestions`, so
a client that connects later can show them. A session built by `chimera
serve` answers `unavailable` on its own; only a session with a user (the
interactive TUI) raises `question_request`.

