## Why

Users need confidence that their work persists beyond a single TUI run and server process. Today, sessions are flat `~/.chimera/sessions/<id>.json` files with no relationship to each other, and the `/sessions` and `/new` commands are stubbed with `"not yet wired to the server in MVP."` Users can't list past sessions, resume any of them across restarts, or fork a session to explore an alternative approach without overwriting the original.

## What Changes

- **BREAKING:** Session persistence moves from a flat `<id>.json` file to a per-session directory `~/.chimera/sessions/<id>/` containing `session.json` (metadata) and `events.jsonl` (append-only event log). Old flat files are ignored, not migrated.
- **Implement existing `/new` and `/sessions` stubs** in the TUI.
- **New `/fork [purpose]` command** to create a child session from the current session's state.
- **New `chimera resume <id>` CLI subcommand** (and `--resume <id>` flag) to launch directly into a previously persisted session.
- **Modified `GET /v1/sessions`** scans disk, not just the in-memory registry.
- **New `POST /v1/sessions/:id/resume`** loads a persisted session into memory.
- **New `POST /v1/sessions/:id/fork`** creates a child session.
- **Session-tree depth indicators** in the `/sessions` picker and a derived `/sessions tree` printout.
- **Session ID, parent indicator, and depth** in the TUI header.
- **SDK additions**: `resumeSession`, `forkSession`. Existing `listSessions` returns disk-scanned data. (`createSession` is unchanged.)

## Capabilities

### New Capabilities

- `session-tree-persistence`: Directory-per-session storage with `session.json` + `events.jsonl`, parent/child relationships, fork semantics.
- `session-lifecycle-api`: New server routes (`/resume`, `/fork`) and modified `GET /v1/sessions`; new SDK methods.
- `session-tui-commands`: TUI implementations of `/new`, `/sessions` (interactive picker), and `/fork`.
- `session-tree-visualization`: Depth-indented picker, `/sessions tree` static printout, ancestry display.

### Modified Capabilities

- `agent-core`: Session type adds `parentId` and `children[]`; persistence requirement is replaced (directory + JSONL); resume requirement is replaced (read `session.json` then load latest `step_finished` snapshot).

## Impact

- **BREAKING:** Old `~/.chimera/sessions/<id>.json` files are ignored. Documented in release notes.
- **Packages affected**: `packages/core` (types, persistence, resume), `packages/server` (new routes), `packages/client` (new methods), `packages/tui` (commands, picker, header), `packages/cli` (resume subcommand).
- **Storage**: `~/.chimera/sessions/<session-id>/{session.json, events.jsonl}`.
- **Sandbox interaction**: Forks in `overlay` sandbox mode copy the parent's overlay upperdir into a new upperdir keyed by the child session id. Other modes share `cwd`.
- **Performance**: Disk scan in `GET /v1/sessions` is O(n) in the number of sessions; cache invalidated on create/delete/fork. Acceptable for typical usage (<1000 sessions).
- **Concurrency**: No locking. Multiple clients writing to the same session id are last-write-wins; documented limitation.
