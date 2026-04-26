## Context

Today's session persistence (`packages/core/src/persistence.ts`) writes the full `Session` object as JSON to `~/.chimera/sessions/<id>.json` on every `step_finished`, using a tmp-file + atomic rename. `Session` already includes `id`, `cwd`, `createdAt`, `messages`, `toolCalls`, `status`, `model`, `sandboxMode`, and `usage` (`packages/core/src/types.ts`). Session IDs are ULIDs via `newSessionId()` (`packages/core/src/ids.ts:7-9`). The `/sessions` and `/new` commands exist in `BUILTIN_COMMANDS` (`packages/tui/src/slash-commands.ts:9-22`) but both fall through to a "not yet wired" stub in `App.tsx`. The server already exposes `POST /v1/sessions`, `GET /v1/sessions` (in-memory only), `GET /v1/sessions/:id`, and `DELETE /v1/sessions/:id` (`packages/server/src/app.ts:19-38`). `ChimeraClient` already has `createSession`, `listSessions`, `getSession`, and `deleteSession` (`packages/client/src/client.ts:84-102`).

The gap is the relationship between sessions (no `parentId` or `children[]`), persistence robustness (entire JSON rewritten every step), and the unimplemented commands.

## Goals / Non-Goals

**Goals:**

- Sessions survive server restart and are listable from disk.
- Forks create a child session that inherits the parent's state at the fork point without mutating the parent.
- `/new`, `/sessions`, `/fork` are functional in the TUI; resume works from CLI launch.
- Persistence is append-only at the per-step granularity (no full rewrites of the message history per step).

**Non-Goals:**

- Git-style merge / rebase between sessions.
- Cross-user session sharing or remote storage.
- Automatic mid-step checkpointing.
- Session compression, archiving, or retention policy.
- Migration of pre-change `<id>.json` files (BREAKING; documented).
- Locking against concurrent writers (documented last-write-wins).
- Session naming / aliases (deferred).
- Force-deletion of sessions with children (deferred; reject with error for now).

## Decisions

### Decision: Directory-per-session with `session.json` and `events.jsonl`

**Choice:** Each session lives in `~/.chimera/sessions/<id>/`:
- `session.json` — metadata only: `id`, `parentId`, `children[]`, `createdAt`, `cwd`, `model` (full `ModelConfig`), `sandboxMode`, `usage`. Written via tmp-file + atomic rename, same as today.
- `events.jsonl` — append-only log of `AgentEvent`s, one per line.

`messages` and `toolCalls` are *not* in `session.json`; they are derived from the event log.

**Rationale:** Atomic rewrites of small metadata are safe; large message history grows append-only. Two clearly typed files beat one fat JSON. Deriving messages from events removes the dual-source-of-truth problem.

**Alternatives considered:**
- SQLite per session: heavier dependency, harder to inspect by hand, no replay-from-step-N.
- Keep flat JSON, add tree fields: doesn't solve append-only persistence or replay.

### Decision: Persisted events are `step_finished`, `permission_resolved`, `run_finished`, plus a synthetic `forked_from`

**Choice:** Not all `AgentEvent`s are persisted. Specifically:
- **Persisted:** `step_finished` (carries the cumulative `messages` and `toolCalls` after the step), `permission_resolved` (audit trail), `run_finished`, and a synthetic `forked_from { parentId, parentEventCount }` written as the first event of any forked session.
- **Not persisted:** `assistant_text_delta`, `tool_call_start`, `tool_call_result`, `tool_call_error`, `permission_request`, `user_message` — these are transient and reconstructable from the `step_finished` snapshot's `messages`.

**Rationale:** Persisting deltas would multiply log size and re-emit them on replay, which is not what consumers want. Snapshots at step boundaries are the natural granularity (already what current persistence does, just append-only). The audit trail of `permission_resolved` is small and useful.

**Alternatives considered:**
- Persist everything: log grows without bound; replay re-emits text-deltas.
- Persist only `step_finished`: loses permission audit trail.

### Decision: Resume reads `session.json`, then loads the last `step_finished`

**Choice:** On resume:
1. Read `session.json` for config (`cwd`, `model`, `sandboxMode`, `parentId`, `children[]`, `usage`).
2. Read `events.jsonl` line by line, skipping blank or malformed trailing lines with a logged warning.
3. Take the most recent `step_finished` event; its payload supplies `messages` and `toolCalls`.
4. Set `status = "idle"`.

**Rationale:** Last-snapshot replay is O(file size) on the line scan but only deserializes one event payload. No replay determinism issues since we're reading state, not re-executing.

### Decision: Fork copies `events.jsonl` from the parent at fork time

**Choice:** When forking session A → B:
1. Allocate a new ULID for B.
2. Create `~/.chimera/sessions/<B>/`.
3. Copy A's `events.jsonl` to B's directory verbatim.
4. Append a `forked_from { parentId: A, parentEventCount: <line count> }` event to B's log.
5. Write B's `session.json` with `parentId: A`, empty `children: []`, fresh `createdAt`, copied `cwd`/`model`/`sandboxMode`, and `usage` reset to zero.
6. Update A's `session.json` to add B to its `children[]`.

**Rationale:** Full event-log copy gives the child complete autonomy — no walk-up parent lookups during resume, no shared mutable state. Parent's `events.jsonl` is append-only so the copy is a stable snapshot. The single `forked_from` marker preserves provenance for visualization.

**Alternatives considered:**
- Walk up `parentId` chain on resume: cheaper at fork, more complex at resume; breaks if a parent is deleted.
- Hardlink `events.jsonl`: brittle across filesystems; child appends would mutate parent.

### Decision: Fork × sandbox mode

**Choice:**
- `off`, `bind`, `ephemeral` modes: child shares parent's `cwd`. No filesystem copy.
- `overlay` mode: copy the parent's overlay upperdir at `~/.chimera/overlays/<parentId>/upper/` to `~/.chimera/overlays/<childId>/upper/` at fork time, using existing `packages/sandbox/src/overlay.ts` primitives.

**Rationale:** The `overlay` mode is already copy-on-write per session id; forks should snapshot the parent's overlay so the child can diverge without affecting the parent. Other modes don't have per-session filesystem state, so sharing `cwd` is the only option.

### Decision: Tree view is the depth-indented picker, plus a static `/sessions tree` printout

**Choice:**
- `/sessions` opens an interactive picker. Each row shows truncated id, relative createdAt, message count, cwd basename, and a tree-prefix (`├──`, `└──`, `│`) reflecting depth. Sorted by root chronological order with children inlined under parents.
- `/sessions tree` (no arguments) prints the same tree to scrollback as a static block, suitable for screenshots / sharing.
- `/sessions <id>` prints details for one session: full id, full cwd, model, parent, child count, and ancestry chain (root → … → this).

**Rationale:** One canonical tree representation, two surfaces (interactive vs static). Avoids the "two ways to see the tree" confusion in the original draft.

### Decision: Delete with children is rejected

**Choice:** `DELETE /v1/sessions/:id` rejects with HTTP 409 and a clear error if the session has any children. A user can delete the children first, or wait for a future force-delete flag (out of scope here).

**Rationale:** Cascading delete is irreversible and easy to misclick; nulling children's `parentId` corrupts the tree shape. Refusing is the conservative default and matches `git branch -d` vs `-D`.

### Decision: Migration is "ignored, documented"

**Choice:** Pre-change flat `~/.chimera/sessions/<id>.json` files are ignored. They are not auto-migrated, not deleted, and not listed.

**Rationale:** Sessions are local working state; the cost of a one-time writing migration tool exceeds the cost of a clear release note. Users can manually re-create or copy out content if needed. The directory and the file form are non-overlapping — a future cleanup tool can remove orphan `<id>.json` files, but that's not in this change.

### Decision: CLI resume

**Choice:** Add `chimera resume <id>` as a subcommand and `--resume <id>` as a top-level flag. Both call `client.resumeSession(id)` then attach the TUI to that session.

**Rationale:** Resume is the headline feature; making it require launching, then `/sessions`, then picking, is poor UX for the common "re-open my last thing" case.

### Decision: Concurrent writers are last-write-wins, no locking

**Choice:** No file lock, no PID lock. Two clients holding the same session id will race on `session.json` (atomic-rename → one wins) and interleave on `events.jsonl` appends (POSIX append is atomic per write under typical line sizes). Documented in user-facing docs.

**Rationale:** Locking adds significant complexity for a misuse case (the user explicitly opened the same session twice). Atomic-rename + small JSONL appends keep filesystem state consistent if not coherent. Revisit if real users hit this.

### Decision: Disk-scan list is cached in-memory

**Choice:** `GET /v1/sessions` walks the sessions directory once at startup, holds the result in a `Map<SessionId, SessionInfo>`, and invalidates entries on `POST /v1/sessions`, `POST /v1/sessions/:id/fork`, and `DELETE /v1/sessions/:id`. List requests serve from the cache.

**Rationale:** Avoids re-walking the directory and re-parsing every `session.json` on every list request. Mutations are server-mediated, so cache invalidation is straightforward.

### Decision: `forkedAt` is dropped

**Choice:** No `forkedAt` field. The child's `createdAt` is the fork time.

**Rationale:** Two timestamps for the same event invites drift. `createdAt` already carries the meaning for forked sessions.

## Risks / Trade-offs

- **[Risk]** A crash mid-append leaves a malformed last line in `events.jsonl`. **Mitigation:** Resume skips and warns; the lost event is at most one step (which the user can re-issue).
- **[Risk]** Directory accumulation over months. **Mitigation:** Out of scope; future archiving change.
- **[Risk]** Fork copy of large `events.jsonl` is slow. **Mitigation:** Acceptable at typical sizes (~MB); revisit with hardlink fallback if it bites.
- **[Trade-off]** Last-write-wins for concurrent writers. Acceptable; documented.
- **[Trade-off]** Replay from snapshot loses inter-step events for audit. Acceptable; `permission_resolved` is the only one that matters and is preserved.

## Migration Plan

No automatic migration. Release note: "Session persistence format changed. Pre-existing `~/.chimera/sessions/*.json` files are ignored. To recover a previous session's contents, open the file directly; new sessions use `~/.chimera/sessions/<id>/`."

## Open Questions

None.
