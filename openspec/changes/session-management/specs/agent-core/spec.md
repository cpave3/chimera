## MODIFIED Requirements

### Requirement: Session lifecycle and state

The `@chimera/core` package SHALL expose a `Session` object carrying, at minimum: a ULID `id`, a `parentId` of type `SessionId | null`, a `children` array of `SessionId`, `cwd`, `createdAt`, the full conversation as AI-SDK `CoreMessage[]`, an ordered list of `ToolCallRecord`s, a `status` field in `{"idle","running","waiting_for_input","waiting_for_permission","error"}`, a `ModelConfig`, a `sandboxMode` value, and a `usage` object.

`sandboxMode` MUST exist on the type for all sessions so that persisted sessions remain readable across changes that extend the set of supported modes.

#### Scenario: Session created through Agent constructor

- **WHEN** the consumer calls `new Agent(opts)` with `opts.cwd`, `opts.model`, `opts.modelClient`, `opts.executor`, and `opts.sandboxMode` and no `opts.parentSessionId`
- **THEN** `agent.session` SHALL be populated with a fresh ULID `id`, `cwd = opts.cwd`, `status = "idle"`, empty `messages` / `toolCalls`, `parentId = null`, empty `children = []`, and `createdAt` set to the current Unix milliseconds

#### Scenario: Session resumed from persisted state

- **WHEN** the consumer constructs an `Agent` with `opts.sessionId` matching a previously persisted session directory at `~/.chimera/sessions/<sessionId>/`
- **THEN** `agent.session` SHALL deserialize `session.json` for `cwd`, `model`, `sandboxMode`, `parentId`, `children`, `usage`, and `createdAt`
- **AND** `agent.session.messages` and `agent.session.toolCalls` SHALL be taken from the most recent `step_finished` event in `events.jsonl`
- **AND** if no `step_finished` event exists, `messages` and `toolCalls` SHALL be empty arrays
- **AND** `status` SHALL be reset to `"idle"` regardless of any persisted value
- **AND** malformed or empty trailing lines in `events.jsonl` SHALL be skipped with a logged warning

#### Scenario: Forked session has parent relationship

- **WHEN** the consumer constructs an `Agent` with `opts.parentSessionId` pointing at an existing persisted session
- **THEN** `agent.session.id` SHALL be a new ULID
- **AND** `agent.session.parentId` SHALL equal `opts.parentSessionId`
- **AND** `agent.session.children` SHALL be empty
- **AND** `agent.session.messages` and `toolCalls` SHALL match the parent's at fork time
- **AND** `agent.session.usage` SHALL be reset to zero
- **AND** the parent's `session.json` SHALL be updated to include the new id in its `children[]`

### Requirement: Session persistence

`@chimera/core` SHALL persist sessions to `~/.chimera/sessions/<sessionId>/` as a directory containing two files:
- `session.json` — metadata only: `id`, `parentId`, `children[]`, `createdAt`, `cwd`, `model`, `sandboxMode`, `usage`. SHALL NOT contain `messages` or `toolCalls`. SHALL be written via tmp-file plus atomic rename.
- `events.jsonl` — append-only log. SHALL contain one JSON-encoded `AgentEvent` per line. SHALL only ever be appended to, never rewritten in place.

Only events of type `step_finished`, `permission_resolved`, `run_finished`, and `forked_from` SHALL be persisted. All other event types SHALL be transient.

On every `step_finished` event, the system SHALL append the event to `events.jsonl` and rewrite `session.json` with current metadata (including any updated `children[]` or `usage`).

#### Scenario: Persisted snapshot reflects latest completed step

- **WHEN** an agent completes step N of a multi-step run
- **THEN** the `step_finished` event for step N SHALL be appended to `events.jsonl`
- **AND** `session.json` SHALL be rewritten with the current `usage` and any other updated metadata
- **AND** `session.json` SHALL NOT contain `messages` or `toolCalls`
- **AND** the directory layout SHALL be intact for future resume

#### Scenario: Transient events are not persisted

- **WHEN** an agent run emits `assistant_text_delta`, `tool_call_start`, `tool_call_result`, `tool_call_error`, `permission_request`, or `user_message` events
- **THEN** these events SHALL NOT appear in `events.jsonl`

#### Scenario: Permission resolution is preserved for audit

- **WHEN** the consumer calls `resolvePermission` and a `permission_resolved` event is emitted
- **THEN** the event SHALL be appended to `events.jsonl` between the surrounding `step_finished` events
