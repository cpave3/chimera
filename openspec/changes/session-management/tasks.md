## 1. Core Types and Persistence (`packages/core`)

- [x] 1.1 Add `parentId: SessionId | null` and `children: SessionId[]` to `Session` in `packages/core/src/types.ts`. Keep `usage`.
- [x] 1.2 Replace flat-file persistence with directory-per-session: `~/.chimera/sessions/<id>/session.json` (atomic tmp+rename) and `~/.chimera/sessions/<id>/events.jsonl` (append).
- [x] 1.3 Update `persistSession()` in `packages/core/src/persistence.ts`: write `session.json` (without `messages`/`toolCalls`) and append the latest event to `events.jsonl`.
- [x] 1.4 Implement event filter for persistence: only `step_finished`, `permission_resolved`, `run_finished`, `forked_from` are written.
- [x] 1.5 Rewrite `loadSession()`: read `session.json`, then scan `events.jsonl`, skip malformed/blank trailing lines (log warning), take the most recent `step_finished` and project its `messages`/`toolCalls` onto the loaded `Session`. Set `status = "idle"`.
- [x] 1.6 Add `forkSession(parentId, opts)` in `persistence.ts`: copy parent's `events.jsonl`, append `forked_from { parentId, parentEventCount }`, write child `session.json` with new ULID and `parentId` set, update parent's `session.json` to add child to `children[]`.
- [x] 1.7 Add `forked_from` variant to `AgentEvent` (`packages/core/src/events.ts`).
- [x] 1.8 Update `Agent` constructor to accept `parentSessionId?: SessionId`; thread through to `persistence.forkSession`. (Implemented as static `Agent.fork()` / `Agent.resume()` factory methods since the constructor must remain sync.)
- [x] 1.9 Confirm `persistSession()` is still called on every `step_finished` (existing call site at `agent.ts:471`) and on `run_finished` (existing call site at `agent.ts:537`).

## 2. Sandbox Fork Behavior (`packages/sandbox`)

- [x] 2.1 Add `forkOverlay(parentId, childId)` in `packages/sandbox/src/overlay.ts` to copy `~/.chimera/overlays/<parentId>/upper/` to `~/.chimera/overlays/<childId>/upper/`.
- [x] 2.2 Wire fork operation: when sandbox mode is `overlay`, call `forkOverlay()` during `forkSession`. For other modes, no filesystem copy. (Wired via `onFork` hook in `buildApp` from CLI's `interactive` and `serve` commands.)

## 3. Server Routes (`packages/server`)

- [x] 3.1 Modify `GET /v1/sessions` to read from disk: scan `~/.chimera/sessions/`, read each `session.json`, return aggregated `SessionInfo[]`. Cache in a `Map<SessionId, SessionInfo>`; invalidate on create / fork / delete.
- [x] 3.2 Add `POST /v1/sessions/:id/resume`: load session via `loadSession()`, register agent in memory, return `{ sessionId }`.
- [x] 3.3 Add `POST /v1/sessions/:id/fork` accepting `{ purpose?: string }`: call `forkSession(parentId)`, return `{ sessionId, parentId }`. Optional `purpose` is recorded in the synthetic `forked_from` event payload.
- [x] 3.4 Modify `DELETE /v1/sessions/:id`: reject with HTTP 409 if `children.length > 0`; otherwise delete the directory and invalidate cache.
- [x] 3.5 Validate `:id` param is a valid ULID format on all routes. (Returns 404 for malformed IDs — they cannot exist by definition — to match existing `getSession('nonexistent')` test semantics.)
- [x] 3.6 On server startup, prime the disk-scan cache. (Lazy on first list; primes immediately after first request, no boot-time penalty.)

## 4. SDK (`packages/client`)

- [x] 4.1 Update `listSessions()` to reflect the disk-scanned response shape (now includes `parentId`, `children[]`, `messageCount`).
- [x] 4.2 Add `resumeSession(id: SessionId): Promise<void>`: POSTs to `/v1/sessions/:id/resume`.
- [x] 4.3 Add `forkSession(id: SessionId, purpose?: string): Promise<{ sessionId: SessionId, parentId: SessionId }>`: POSTs to `/v1/sessions/:id/fork`.
- [x] 4.4 Export `SessionInfo`, `ForkResponse` types from `@chimera/client`.

## 5. CLI (`packages/cli`)

- [x] 5.1 Add `chimera resume <id>` subcommand: calls `client.resumeSession(id)`, attaches TUI to that session.
- [x] 5.2 Add `--resume <id>` top-level flag with the same behavior.
- [x] 5.3 Error clearly if the id is unknown or directory missing.

## 6. TUI Commands (`packages/tui`)

- [x] 6.1 Replace the `/new` stub in `App.tsx` with a real handler: call `client.createSession()`, switch the TUI to the new id, clear scrollback, print a confirmation with the truncated id.
- [x] 6.2 Replace the `/sessions` stub: open an interactive `SessionPicker` Ink component.
- [x] 6.3 Implement `SessionPicker` with arrow-key navigation; row format `<tree-prefix> <truncated-id>  <relative-time>  <messageCount> msg  <cwd-basename>`; Enter switches to the selected session via `client.resumeSession(id)`.
- [x] 6.4 Implement `/sessions tree` (no-arg variant within `/sessions <subcommand>`): print the same tree as a static scrollback block.
- [x] 6.5 Implement `/sessions <id>`: print details for one session — full id, cwd, model, parent (or "root"), child count, ancestry chain.
- [x] 6.6 Implement `/fork [purpose]`: call `client.forkSession(currentId, purpose)`, switch to the new child, clear scrollback, print confirmation noting the parent.
- [x] 6.7 Update TUI header to show truncated current session id and a `(forked)` marker when `parentId !== null`. (Rendered in the StatusBar's model row, not the static Header — the Header is committed once via `<Static>` and cannot update on session switch.)
- [x] 6.8 Disable the main composer while the picker is mounted; close on Escape.

## 7. Documentation

- [x] 7.1 Release note for the BREAKING file-format change; note that `<id>.json` files are ignored.
- [x] 7.2 Update README with `/new`, `/sessions`, `/fork`, `chimera resume`.
- [x] 7.3 Document directory layout `~/.chimera/sessions/<id>/{session.json, events.jsonl}` and the persisted-event filter.
- [x] 7.4 Document the last-write-wins concurrency limitation.
- [x] 7.5 Document that fork in `overlay` sandbox mode copies the upperdir; other modes share `cwd`.

## 8. Testing

- [x] 8.1 Unit: `persistSession` writes only metadata to `session.json` and appends only filtered events to `events.jsonl`.
- [x] 8.2 Unit: `loadSession` finds the latest `step_finished` and ignores malformed trailing lines (test with a deliberately truncated last line).
- [x] 8.3 Unit: `forkSession` produces a child with copied events, a `forked_from` marker, correct `parentId`, and updates parent's `children[]`.
- [x] 8.4 Unit: pre-change flat `<id>.json` files are not listed by the disk scanner.
- [x] 8.5 Integration: `GET /v1/sessions` returns disk-scanned results; cache invalidation on create / fork / delete.
- [x] 8.6 Integration: `POST /v1/sessions/:id/resume` round-trip — verified that a fresh registry can resume a previously persisted session.
- [x] 8.7 Integration: `POST /v1/sessions/:id/fork` creates a child whose `events.jsonl` includes a `forked_from` marker (full send-isolation test deferred — covered by unit test 8.3).
- [x] 8.8 Integration: `DELETE` with children returns 409.
- [ ] 8.9 Integration: `chimera resume <id>` from cold start. (Covered by server route test 8.6 + unit-level resume; full CLI subprocess test deferred — the existing CLI tests don't yet have a fixture spawning the resume subcommand end-to-end.)
- [x] 8.10 TUI: `SessionPicker` renders depth-indented tree, navigates with arrows, switches on Enter.
- [ ] 8.11 TUI: `/fork` switches and updates header marker. (Deferred — the larger gap was that `slash-dispatch.test.tsx`'s stub `ChimeraClient` doesn't expose `getSession`/`listSessions`/`createSession`/`resumeSession`/`forkSession`, so every new TUI handler runs against `undefined.method()` and fails silently. A follow-up review extends the stub and adds dispatch tests for `/new`, `/sessions`, and `/fork`; the header-marker assertion can ride on those.)
- [x] 8.12 Sandbox: `forkOverlay` copies upperdir contents, tolerates exit 23, throws on other failures.
- [x] 8.13 Concurrency: two writers to the same session produce a coherent (last-write-wins) `session.json` and a non-corrupt `events.jsonl` (interleaved appends remain valid JSON lines).
