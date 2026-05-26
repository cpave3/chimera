## Why

Users need a way to "undo" parts of an ongoing conversation and either re-try from an earlier point or branch off to explore alternatives. Without rewind, the only options are `/fork` (forks from the current state only) or manually starting a new session and retyping context. Rewinding to a prior user message and preloading that prompt into the input buffer makes iteration much faster.

## What Changes

- Add checkpoint discovery to `events.jsonl`: scan persisted snapshot events and map each one to a rewindable boundary defined by the corresponding user message.
- Add in-place session truncation server-side: given a selected checkpoint, truncate `events.jsonl` at the snapshot covering the chosen point, reset the live `Session` state, and return the truncated session.
- Add fork-from-checkpoint: extend the existing `/fork` endpoint so it can fork from a historical checkpoint instead of the current tail.
- Add TUI `/rewind` slash command: opens a modal picker listing every user message in the session, each annotated with a lightweight summary of subsequent tool calls. Enter rewinds in-place; Shift+Enter forks.
- On in-place rewind, preload the selected message text into the TUI input buffer.
- Queue rewind requests behind the existing input queueing behavior (`/rewind` waits for the agent to finish before opening the picker).

## Capabilities

### New Capabilities
- `session-rewind`: Checkpoint listing, events.jsonl truncation, in-place rewind, fork-from-history, tool-call summary extraction.

### Modified Capabilities
- `tui`: Adds `/rewind` built-in slash command and `RewindPicker` inline modal. No existing spec requirements change.
- `agent-server`: Adds `GET /v1/sessions/:id/checkpoints` and `POST /v1/sessions/:id/rewind`. Extends `POST /v1/sessions/:id/fork` with optional `rewindIndex` body field. No existing spec requirements are broken.

## Impact

- **Core persistence** (`@chimera/core`): New functions to scan `events.jsonl` for checkpoints and truncate the file at a given snapshot position.
- **Server** (`@chimera/server`): Two new REST endpoints, fork endpoint extension.
- **Client** (`@chimera/client`): Two new API methods.
- **TUI** (`@chimera/tui`): New `/rewind` built-in, new `RewindPicker` component, wiring into the App's slash-command dispatch and input-guard system.
- **Filesystem**: `events.jsonl` is destructively truncated on in-place rewind.
