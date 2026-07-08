## ADDED Requirements

### Requirement: Agent drains mid-run injected messages at each clean step boundary

The `Agent` SHALL expose `injectRunMessage(content: string, images?: string[]): void`. When a run is active, the message SHALL be queued on an internal buffer and drained at the next clean (non-interrupted, non-errored) step boundary, after response messages are attached and after the `terminalReason !== 'stop'` check.

On an intermediate step (tool calls emitted), the drained messages SHALL appear in the next `streamText` prompt. On a terminal step (stop), the run loop SHALL continue so the model responds to the drained messages. A fresh `AbortController` SHALL be installed before the continuation so the new turn is independently interruptible.

The `terminalStepCount` SHALL increment before the continuation, so the `maxTerminalSteps` cap still bounds the number of injected turns.

When the run is interrupted or errors, pending injected messages SHALL be dropped (not carried into the next run). The buffer SHALL be cleared at the start of every fresh `run()`.

For each drained message, the agent SHALL push a user message onto `session.messages`, emit a `user_message` event, and persist a `message_appended` event so resume sees the injected content.

#### Scenario: Inject during a tool-call step

- **WHEN** a run is active on step 1 (tool call in flight) and `injectRunMessage("correction")` is called
- **THEN** step 2's prompt SHALL contain "correction" as a user message, and a `user_message` event SHALL be emitted.

#### Scenario: Inject on a terminal step

- **WHEN** a run reaches a terminal (stop) step and `injectRunMessage("follow-up")` was queued during that step
- **THEN** the run loop SHALL continue and the model SHALL produce another turn responding to "follow-up".

#### Scenario: Inject dropped on interrupt

- **WHEN** a run is interrupted during a tool call and `injectRunMessage("late")` was queued
- **THEN** "late" SHALL NOT appear in `session.messages` and a subsequent run SHALL NOT see it in its prompt.

## MODIFIED Requirements

### Requirement: Server injectMessage routes to the mid-run buffer when a run is active

`AgentRegistry.injectMessage` SHALL return `'injected'` when a run is active (and no compaction, idle-inject, or rewind is active), by calling `agent.injectRunMessage(content, images)` synchronously. It SHALL NOT call `snapshotWorkspace` or publish a `user_message` event on the bus for the mid-run path — the run loop emits the event at drain time.

It SHALL still return `'already-running'` when a compaction, idle-inject, or rewind is active, since there is no run to inject into.

The idle path (no run active) SHALL remain unchanged: `snapshotWorkspace` + `agent.appendMessage` + `bus.publish(user_message)`.

#### Scenario: Inject during an active run

- **WHEN** a run is active and `injectMessage(id, "correction")` is called
- **THEN** the return value SHALL be `'injected'` (HTTP 204), and a `user_message` event SHALL be published on the bus after the next step boundary.

#### Scenario: Inject during compaction

- **WHEN** a compaction is active and `injectMessage(id, "x")` is called
- **THEN** the return value SHALL be `'already-running'` (HTTP 409).

### Requirement: TUI injects regular messages mid-run instead of queuing

When a run is active, the TUI SHALL send regular (non-`!`, non-`/`) user messages via `client.appendMessage` (the mid-run inject path) and surface an "injected: ..." info line, rather than queueing until run end.

When the session is busy but no run is active (compacting or a `!` command in flight), the TUI SHALL queue regular messages as before.

`!` commands, `/rewind`, `/compact`, and other slash actions SHALL continue to queue while busy.

Expanded user-command and skill bodies SHALL follow the same rule: inject mid-run when `running`, send directly when idle.

#### Scenario: Regular message while running

- **WHEN** the user types a regular message and presses Enter while a run is active
- **THEN** `client.appendMessage` SHALL be called with the message text and the frame SHALL show "injected: ..." without a "queued" indicator.

#### Scenario: Message while compacting

- **WHEN** the user types a regular message while compaction is in progress (no active run)
- **THEN** the message SHALL be queued and sent as the next turn once the session is idle.
