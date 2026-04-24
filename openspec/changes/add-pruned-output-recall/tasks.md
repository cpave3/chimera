## 1. Package scaffolding

- [ ] 1.1 Add `packages/recall/` to the workspace. Depends on `@chimera/core` types, `@chimera/tools` (for tool registration), `better-sqlite3`.
- [ ] 1.2 Define `RecallEntry`, `RecallStore` interface, and a `SqliteRecallStore` class.

## 2. Storage

- [ ] 2.1 Implement `SqliteRecallStore` with `put(entry)`, `get(id)`, `delete(id)`, `purgeOlderThan(ts)`.
- [ ] 2.2 Lazy-create the store file at `~/.chimera/recall/<sessionId>.sqlite` on first write.
- [ ] 2.3 Implement the `entries` table schema and indexes (`created_at` for TTL scans).
- [ ] 2.4 Implement the deterministic `pr_<hash>` id generator with collision-extend-to-12 logic.
- [ ] 2.5 Unit tests: deterministic IDs, idempotent puts, TTL purge, missing-id get.

## 3. `recall` tool

- [ ] 3.1 Define Zod schema for `{ id, start_line?, end_line?, search? }`.
- [ ] 3.2 Implement line slicing + search filtering; enforce `maxRecallBytes` cap.
- [ ] 3.3 Register the tool in `@chimera/tools`' `buildTools` when `recall.enabled !== false`; bypass `permissionGate`.
- [ ] 3.4 Unit tests: line slice, search filter, truncation flag, missing id path, no permission prompt occurs.

## 4. Compaction hook

- [ ] 4.1 Add an `onBeforeReplace` extension point to `@chimera/compaction` (small, additive).
- [ ] 4.2 In `@chimera/recall`, register the hook at session start: walk the slice, extract large `tool-result`s, `put` them, rewrite content to the stub.
- [ ] 4.3 Preserve the preceding `tool-call` message unchanged.
- [ ] 4.4 Unit tests: archival above threshold, pass-through below threshold, stub format, idempotency when the same content is compacted twice.

## 5. CLI / config / cleanup

- [ ] 5.1 Parse `recall.*` config keys with the documented defaults.
- [ ] 5.2 Hook `chimera sessions rm <id>` to also delete `~/.chimera/recall/<id>.sqlite*`.
- [ ] 5.3 Validate that `recall.enabled === true && @chimera/compaction is absent` is allowed but emits a one-line info log explaining recall is inert without compaction.

## 6. Documentation / E2E

- [ ] 6.1 Write `RECALL.md`: how archival works, stub format, tool usage, config.
- [ ] 6.2 E2E: long session with stub model + compaction + one large `bash` output → archival occurs → model subsequently calls `recall` and receives the content.
- [ ] 6.3 E2E: missing-id recall gracefully returns an error result.
- [ ] 6.4 E2E: session deletion cleans up the SQLite file.
- [ ] 6.5 E2E: `recall.enabled: false` skips registration and hook installation entirely.
