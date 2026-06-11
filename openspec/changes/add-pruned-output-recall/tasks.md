> **Implementation note (2026-06-11):** Implemented with a file-per-entry
> store (`~/.chimera/recall/<sessionId>/<id>.json`) instead of SQLite — the
> repo targets Node >= 20 with zero native deps, and `node:sqlite` requires
> 22.5+. The compaction integration landed as a `createPruner` factory on
> `CompactorOptions` (phase 1 of tiered compaction) rather than an
> `onBeforeReplace` hook; prune-only compactions skip the LLM summarize
> phase entirely when they bring the estimate back under budget.

## 1. Package scaffolding

- [x] 1.1 Add `packages/recall/` to the workspace. Depends on `@chimera/core` types only (file store, no better-sqlite3).
- [x] 1.2 Define `RecallEntry` and `RecallStore` (file-backed class, not SQLite).

## 2. Storage

- [x] 2.1 Implement `RecallStore` with `put`, `get`, TTL GC (delete/purge folded into lazy GC by mtime).
- [x] 2.2 Lazy-create the store dir at `~/.chimera/recall/<sessionId>/` on first write.
- [x] 2.3 ~~SQLite schema~~ N/A for the file backend.
- [x] 2.4 Deterministic `pr_<hash>` id generator with collision-extend-to-12 logic.
- [x] 2.5 Unit tests: deterministic IDs, idempotent puts, TTL purge, missing-id get.

## 3. `recall` tool

- [x] 3.1 Zod schema for `{ id, start_line?, end_line?, search? }`.
- [x] 3.2 Line slicing + search filtering; 100KB cap with truncated flag.
- [x] 3.3 Registered in `buildTools` when `ToolContext.recall` is wired (CLI skips it when `recall.enabled === false`); never touches `permissionGate`.
- [x] 3.4 Unit tests: line slice, search filter, truncation flag, missing id path.

## 4. Compaction hook

- [x] 4.1 `createPruner` factory on `CompactorOptions` (per-session, since stores are per-session).
- [x] 4.2 `createRecallPruner` walks `messages[0..keepStart)`, archives large `tool-result` outputs, rewrites them to stubs.
- [x] 4.3 Preceding `tool-call` parts (args) preserved unchanged; messages rewritten in place, never removed.
- [x] 4.4 Unit tests: archival above threshold, pass-through below, stub format, idempotency (stubs never re-archived).

## 5. CLI / config / cleanup

- [x] 5.1 `recall.*` config keys (`enabled`, `archiveThresholdTokens`, `ttlDays`).
- [x] 5.2 `deleteSession` removes `~/.chimera/recall/<id>/` alongside session data.
- [ ] 5.3 Info log when recall enabled but compaction disabled (inert) — skipped; the recall tool still serves previously archived entries, so the log would mislead.

## 6. Documentation / E2E

- [x] 6.1 Documented in README ("Context management") and docs/COMPACTION.md.
- [x] 6.2 Covered by tiered-compaction tests: prune archives a large output, summary preserves pr_ ids, recall returns content.
- [x] 6.3 Missing-id recall returns an error result (unit test).
- [x] 6.4 Session deletion cleans up the recall dir.
- [x] 6.5 `recall.enabled: false` skips store creation, tool registration, and the prune phase.
