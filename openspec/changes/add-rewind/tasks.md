## 1. Core Persistence

- [x] 1.1 Add `Checkpoint` type in `@chimera/core` with `index`, `userMessage`, `toolCallSummary`, `truncateByteOffset`.
- [x] 1.2 Implement `readCheckpoints(sessionId, home)` in `persistence.ts`: scan `events.jsonl`, reconstruct message arrays from snapshots, identify user-message boundaries, compute tool call summaries from `tool-call` parts, record byte offsets.
- [x] 1.3 Implement `truncateEventsAtIndex(sessionId, index, home)` in `persistence.ts`: find the stored `truncateByteOffset` for the checkpoint, truncate `events.jsonl` at that byte offset (or clear file if index == 0), load the latest snapshot from truncated file, return it.
- [x] 1.4 Extend `forkSession()` in `persistence.ts` to accept `rewindIndex?: number`: copy parent's events, then call `truncateEventsAtIndex()` on the child before writing metadata.

## 2. Server

- [x] 2.1 Add `GET /v1/sessions/:id/checkpoints` endpoint in `app.ts`: validate ULID, read checkpoints from disk, return array (or 404 if session missing).
- [x] 2.2 Add `POST /v1/sessions/:id/rewind` endpoint in `app.ts`: validate body `{ index: number }`, reject if session has active run (409), call truncate logic, patch live agent state, persist metadata, return `{ sessionId }`.
- [x] 2.3 Extend `POST /v1/sessions/:id/fork` in `app.ts`: parse optional `rewindIndex` from body, pass to `coreForkSession()`, return normal fork response.

## 3. Client

- [x] 3.1 Add `listCheckpoints(sessionId: SessionId)` to `ChimeraClient`.
- [x] 3.2 Add `rewindSession(sessionId: SessionId, index: number)` to `ChimeraClient`.
- [x] 3.3 Extend `forkSession(sessionId, purpose?, rewindIndex?)` to forward `rewindIndex` in the request body.

## 4. TUI

- [x] 4.1 Add `/rewind` to `BUILTIN_COMMANDS` in `slash-commands.ts`.
- [x] 4.2 Create `RewindPicker` component: accepts checkpoints array, current highlight, onRewind(index), onFork(index), onCancel(). Renders border + index + userMessage + toolCallSummary. Keyboard: Up/Down/j/k navigate, Enter rewinds, Shift+Enter forks, Escape cancels.
- [x] 4.3 Wire `RewindPicker` into `App.tsx`: add `rewindPicker` state, guard `useInput` when open (suppress chars, Escape/Ctrl+C close picker), render picker in the layout.
- [x] 4.4 Implement `/rewind` slash-command dispatch in `App.tsx`: call `client.listCheckpoints()`, set `rewindPicker` state (or info if empty).
- [x] 4.5 Implement in-place rewind callback: call `client.rewindSession()`, clear scrollback, rehydrate via `client.getSession()`, set input buffer to the checkpoint's user message.
- [x] 4.6 Implement fork-from-checkpoint callback: call `client.forkSession()` with `rewindIndex`, clear scrollback, switch active session, rehydrate, set input buffer to checkpoint text.

## 5. Tests

- [x] 5.1 Add `persistence.test.ts` cases for `readCheckpoints`: empty session, single turn, multiple turns with tool calls.
- [x] 5.2 Add `persistence.test.ts` cases for `truncateEventsAtIndex`: truncate to middle, truncate to zero, verify snapshot loaded correctly.
- [x] 5.3 Add `persistence.test.ts` case for `forkSession({ rewindIndex })`: child has truncated history.
- [x] 5.4 Add `app.test.ts` server tests for `/checkpoints`, `/rewind`, and `/fork` with `rewindIndex`.
- [x] 5.5 Add `slash-dispatch.test.tsx` tests: `/rewind` opens picker, Enter triggers rewind with correct index, Shift+Enter triggers fork, Escape cancels.
- [x] 5.6 Add `slash-dispatch.test.tsx` test: after in-place rewind, the selected message text is in the buffer.
