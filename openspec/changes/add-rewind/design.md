## Context

Chimera sessions are append-only event logs (`events.jsonl`) with cumulative snapshots at step boundaries. The TUI displays conversations derived from the session's messages array. Forking creates a child with the parent's full history copied forward, but there is no way to revert or branch from an earlier point. This change adds in-place rewind and fork-from-history.

## Goals / Non-Goals

**Goals:**

- Users can list rewindable checkpoints per session and choose one to roll back to.
- In-place rewind truncates the event log and resets live session state to a snapshot before the chosen user message.
- Forking supports an optional rewind target, creating a child session truncated at the chosen point.
- The rewind operation enters the normal input queue and only executes when the agent is idle.
- The TUI picker displays user message text plus a lightweight summary of subsequent tool calls.
- On in-place rewind, the selected message text is preloaded into the input buffer (not auto-submitted).

**Non-Goals:**

- Visual timeline or graph view of session branches.
- Forward-winding back to "future" states after truncation.
- Rewinding while a run is active (queued instead).
- Persisting checkpoint metadata separately from `events.jsonl`.
- Tool result introspection for rich summaries (only tool name + path arg extraction).

## Decisions

### D1. Checkpoints map to user-message positions in `session.messages`

**Decision:** A checkpoint is identified by the position (index) at which a user message begins in the `messages` array. The server derives this by scanning `events.jsonl` and tracking how messages accumulate across `step_finished` / `message_appended` snapshots.

**Why:** The user thinks in conversation turns, not event log lines. Every user message is a natural rewind boundary. The server can reconstruct this mapping by replaying the snapshot events.

### D2. Truncate `events.jsonl` literally at the snapshot covering the checkpoint

**Decision:** The server finds the latest snapshot whose messages contain at least up to (but not including) the target user message. It calls `fs.truncate()` at the byte offset of the next event line, or clears the file entirely for checkpoint 0.

**Why:** Literal truncation keeps the file clean, avoids synthetic marker lines, and means `readLatestStepSnapshot` naturally finds the correct state on next resume. The file offset is precomputed during the `GET checkpoints` scan.

### D3. Checkpoint 0 means "before first user message"

**Decision:** The earliest rewindable point is before the first user message was ever sent. For this case, truncation leaves `events.jsonl` empty (or deleted), and the session resets to empty `messages`/`toolCalls`/`usage`. The system prompt is not in `messages`; it will be re-injected by the agent factory on next run.

**Why:** The system prompt is injected via the AI SDK `system:` option, not as a message. Resetting messages to empty is correct. This avoids needing a baseline snapshot.

### D4. Tool call summaries come from `messages`, not `toolCalls`

**Decision:** The checkpoint summary scans assistant message `tool-call` parts to count tool names and extract `path` arguments. Results are not inspected.

**Why:** `toolCalls` is not guaranteed to carry `toolCallId` correlation back to message parts, and we want summaries derived from the canonical persisted data. Path extraction is sufficient for the human-readable preview.

### D5. Enter = rewind in-place, Shift+Enter = fork

**Decision:** The picker supports two primary actions bound to the standard Enter key and its Shift variant. Escape cancels.

**Why:** This is idiomatic (primary vs secondary action) and keeps the slash-command surface small (no need for `/fork-at`).

### D6. The picker is modal and blocks other input

**Decision:** While `RewindPicker` is open, character input is suppressed, Ctrl+C exits the picker, and arrow keys navigate checkpoints.

**Why:** Prevents accidental buffer mutations while the user is focused on history selection.

## Risks / Trade-offs

- **[Rewind truncates history permanently]** There is no "undo rewind". Mitigation: fork (Shift+Enter) preserves the original branch.
- **[File offset stability across concurrent writes]** If a run writes to `events.jsonl` while the TUI is displaying the checkpoint list (between `GET checkpoints` and `POST rewind`), the stored byte offset could be stale. Mitigation: The rewind request is queued until the agent is idle, so no concurrent writes can occur during the actual truncation.
- **[Very long event logs slow checkpoint scanning]** Scanning `events.jsonl` is `O(n)` in events. Mitigation: Rewind is an infrequent interaction; full scan is acceptable.
- **[Message positions are not UUIDs]** If a user sends identical messages, checkpoints are indistinguishable except by position index. Mitigation: The picker also shows relative order number (e.g. "[1]", "[2]").

## Migration Plan

Additive. No migration needed for existing sessions; they simply gain the ability to rewind once this code is deployed. Existing `events.jsonl` files are scanned correctly because all snapshot types (`step_finished`, `message_appended`) carry the full `messages` array.

## Open Questions

None remaining.
