## Why

When the user sends a message while the agent is mid-run, it is queued and only
delivered after the run finishes — often long after the relevant context has
passed. The user wants the agent to see the message "as soon as reasonable,
usually after the next tool call," so it can factor the correction or addition
into its current trajectory instead of completing a now-stale plan first.

## What Changes

- Add a mid-run injection buffer on the `Agent`: `injectRunMessage(content, images?)`
  queues a user message that the run loop drains at the next clean step
  boundary (after tool results, before the next `streamText`). On a terminal
  step the loop continues so the model responds; on an interrupted/errored step
  the buffer is dropped ("interrupt means stop").
- Route the server's `injectMessage` (the `POST /messages?append=true` path) to
  the mid-run buffer when a run is active, instead of returning `409
  already-running`. The idle path is unchanged.
- Change the TUI so regular messages typed while a run is active are injected
  mid-run (via `client.appendMessage`) rather than queued until run end. `!`
  commands, `/rewind`, `/compact`, and other slash actions still queue.
- No new client API surface and no new event types; the existing `user_message`
  event is emitted by the run loop at drain time.

## Capabilities

### New Capabilities

- `mid-run-message-injection`: Agent-side buffer and step-boundary drain that
  lets a user message land between tool calls of an active run.

### Modified Capabilities

- `agent-server`: `injectMessage` returns `'injected'` (HTTP 204) during an
  active run instead of `'already-running'` (HTTP 409), routing to the agent's
  mid-run buffer. The 409 is still returned when a compaction, idle-inject, or
  rewind is active.
- `tui`: Regular messages and expanded command/skill bodies sent while a run
  is active are injected mid-run; the post-run queue is reserved for `!`
  commands and slash actions that need an idle session.

## Impact

- **Packages affected**: `packages/core` (agent run loop + new method),
  `packages/server` (registry routing), `packages/tui` (handleSubmit +
  command/skill dispatch). `packages/client` is unchanged.
- **Breaking changes**: The observable contract of `POST /messages?append=true`
  during a run changes from 409 to 204. No internal caller depends on the 409
  for control flow; the TUI previously queued locally and never sent the append
  while busy.
- **Persistence**: Injected messages are persisted via the existing
  `message_appended` event at drain time, so resume sees them.
