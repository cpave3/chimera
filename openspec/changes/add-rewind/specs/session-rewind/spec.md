## ADDED Requirements

### Requirement: Server can list rewindable checkpoints

The server SHALL expose `GET /v1/sessions/:id/checkpoints`. It SHALL return an array of `Checkpoint` objects in chronological order (oldest first), each containing:

- `index` (number): the user-message position in `session.messages` before which truncation occurs.
- `userMessage` (string): the text content of the user message.
- `toolCallSummary` (string): a human-readable summary of tool calls that followed this user message (before the next user message).
- `truncateByteOffset` (number): the byte offset in `events.jsonl` of the last snapshot that contains the state before this user message.

The first checkpoint SHALL always have `index = 0` representing the state before the first user message with empty history.

#### Scenario: Listing checkpoints for a multi-turn session
- **WHEN** the client GETs `/v1/sessions/SESS123/checkpoints`
- **THEN** the response SHALL contain one `Checkpoint` per user message in the session, in chronological order, with the first checkpoint having `index: 0` and the last having `index` equal to the total number of user messages minus one.

#### Scenario: Empty session returns single checkpoint
- **WHEN** the client GETs checkpoints for a session with no user messages
- **THEN** the response SHALL return an array with one checkpoint having `index: 0`, empty `userMessage`, empty `toolCallSummary`, and `truncateByteOffset: 0`.

### Requirement: Server can perform in-place rewind

The server SHALL expose `POST /v1/sessions/:id/rewind` with body `{ index: number }`. This endpoint SHALL:

1. Verify the session exists and is idle. If a run is active, respond `409 Conflict`.
2. Truncate `events.jsonl` at the byte offset corresponding to the checkpoint with the given `index`.
3. For index 0, clear or delete `events.jsonl` entirely and reset the session to empty `messages`, `toolCalls`, and `usage`.
4. For indices > 0, load the latest snapshot from the truncated file and replace the session's in-memory `messages`, `toolCalls`, and `usage` with the snapshot values.
5. Persist `session.json` metadata immediately so the truncated state survives server restart.
6. Respond `{ sessionId }` on success.

#### Scenario: Rewind to checkpoint 0
- **WHEN** the client POSTs `{ index: 0 }` to `/v1/sessions/SESS123/rewind`
- **THEN** `events.jsonl` SHALL be empty, `session.messages` SHALL contain only the system prompt (or be empty if injected via `system:` option), and the response SHALL be `{ sessionId: "SESS123" }`.

#### Scenario: Rewind to middle of conversation
- **WHEN** the client POSTs `{ index: 2 }` for a session with 5 user messages
- **THEN** `events.jsonl` SHALL be truncated so the last preserved snapshot contains state before the 3rd user message, `session.messages` SHALL contain exactly those messages up to that point, and the response SHALL be `{ sessionId: "SESS123" }`.

#### Scenario: Rewind while busy
- **WHEN** a run is active on the session and the client POSTs to `/v1/sessions/:id/rewind`
- **THEN** the server SHALL respond `409 Conflict` and not modify the file.

### Requirement: Fork supports optional rewind index

The server SHALL extend `POST /v1/sessions/:id/fork` to accept an optional `{ rewindIndex?: number }` body field. When `rewindIndex` is provided, the server SHALL:

1. Load the parent session.
2. Copy parent's `events.jsonl` to the child.
3. Truncate the child's `events.jsonl` at the checkpoint corresponding to `rewindIndex`, identical to in-place rewind logic.
4. Create the child session entry in the registry with the truncated state.
5. Respond `{ sessionId, parentId }`.

#### Scenario: Fork from historical checkpoint
- **WHEN** the client POSTs `{ purpose: "explore alt", rewindIndex: 2 }` to `/v1/sessions/PARENT/fork`
- **THEN** the child session SHALL be created with history truncated before the 3rd user message, and the response SHALL contain a new session id and `parentId: "PARENT"`.

### Requirement: Client exposes rewind APIs

`@chimera/client` SHALL expose:

- `listCheckpoints(sessionId)` → `Promise<Checkpoint[]>`
- `rewindSession(sessionId, index)` → `Promise<{ sessionId: SessionId }>`
- Extend `forkSession(sessionId, purpose?, rewindIndex?)` to forward the optional `rewindIndex`.

#### Scenario: Client lists checkpoints
- **WHEN** `client.listCheckpoints("SESS123")` is called
- **THEN** it SHALL perform a `GET` to `/v1/sessions/SESS123/checkpoints` and return the parsed array.

### Requirement: TUI supports /rewind slash command

The TUI SHALL add `/rewind` to `BUILTIN_COMMANDS`. When invoked:

1. If the queueing layer shows the agent is running, enqueue `/rewind` (standard input behavior).
2. When the agent is idle, call `client.listCheckpoints()` and render a `RewindPicker` overlay.
3. The picker SHALL display each checkpoint as: `[index] userMessageText · toolCallSummary`.
4. Pressing Enter on a highlighted checkpoint SHALL call `client.rewindSession(sessionId, checkpoint.index)`, clear the scrollback, rehydrate from the truncated session, and preload `checkpoint.userMessage` into the input buffer.
5. Pressing Shift+Enter SHALL call `client.forkSession(sessionId, undefined, checkpoint.index)`, clear the scrollback, switch to the new child session, and rehydrate.
6. Pressing Escape SHALL close the picker and cancel.

While the picker is open, character input SHALL be suppressed and Ctrl+C SHALL close the picker without exiting the TUI.

#### Scenario: In-place rewind preloads message
- **WHEN** the user selects checkpoint N in the picker and presses Enter
- **THEN** the session is rewinded, the scrollback refreshes, and the input buffer contains the text of the selected user message.

#### Scenario: Fork from picker
- **WHEN** the user selects checkpoint N and presses Shift+Enter
- **THEN** a new child session is created with truncated history, the TUI switches to it, and the input buffer contains the text of the selected user message.
