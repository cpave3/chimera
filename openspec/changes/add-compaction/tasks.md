## 1. Package scaffolding

- [ ] 1.1 Add `packages/compaction/` with `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`. Depends on `@chimera/core` types + `@chimera/providers`.
- [ ] 1.2 Define `Compactor`, `CompactionConfig`, `CompactionSummary`, `CompactionEvent` types.

## 2. Token estimation

- [ ] 2.1 Implement `estimateTokens(messages)` as a simple `length/4` heuristic with a per-message overhead constant.
- [ ] 2.2 Add a hook point so a provider-aware estimator can replace the heuristic later without API change.
- [ ] 2.3 Unit tests: monotonicity (more content → higher estimate), reasonable magnitude bounds.

## 3. Session file-ops tracking

- [ ] 3.1 Add `fileOps: { reads: Set<string>, writes: Set<string> }` to `Session` in `@chimera/core`; serialize as sorted arrays; deserialize with defaults.
- [ ] 3.2 Update `read`/`write`/`edit` tool handlers to push into the active session's `fileOps` after successful completion (absolute resolved paths).
- [ ] 3.3 Unit test: a session that reads one file and writes another has both populated correctly; overwritten `write` only increments once.

## 4. Compactor core

- [ ] 4.1 Implement `maybeCompact(session, opts)`: threshold check → delegate to `compact()`.
- [ ] 4.2 Implement `compact(session, opts)`: compute `k`, adjust boundary to not split tool pairs, call summarization model, construct synthetic message, return new `messages`.
- [ ] 4.3 Implement summarization prompt producing the exact section headers from the spec; pass previous summary (if any) as extra context.
- [ ] 4.4 Populate the `<files>` block from `session.fileOps`.
- [ ] 4.5 Unit tests: recent-tail preservation boundary math; tool-pair protection; idempotent section headers across successive compactions; `<files>` accumulation.

## 5. Agent loop integration

- [ ] 5.1 In `@chimera/core`, invoke `compactor.maybeCompact` at the start of each step.
- [ ] 5.2 On successful compaction, replace `session.messages`, emit `compaction_started` / `compaction_finished` events before the next `streamText` call.
- [ ] 5.3 On compaction failure, emit `compaction_failed`, keep messages unchanged, proceed — the next provider call will error normally if the window is actually exceeded.

## 6. Persisted log

- [ ] 6.1 Implement append writer for `~/.chimera/sessions/<id>.compactions.jsonl`.
- [ ] 6.2 Ensure atomic-enough append (single `fs.appendFile` call); document the "at-most-one compaction line may be partial on crash" risk.
- [ ] 6.3 Unit test: three sequential compactions produce three ordered lines.

## 7. Server endpoint

- [ ] 7.1 Implement `POST /v1/sessions/:id/compact`; respond 202 (compaction runs asynchronously and events flow via SSE).
- [ ] 7.2 Return 409 if a compaction or run is already in progress for this session.
- [ ] 7.3 Update `GET /v1/sessions/:id` to include `compactionCount` + `lastCompactedAt`.

## 8. CLI / config

- [ ] 8.1 Add `compaction` config block handling and defaults.
- [ ] 8.2 Implement the startup invariant check (`reserveTokens + keepRecentTokens < contextWindow`).
- [ ] 8.3 Expose `--no-compaction` CLI flag as a per-session override.
- [ ] 8.4 Allow `compaction.model` to resolve through the `ProviderRegistry` like the main model.

## 9. TUI

- [ ] 9.1 Add `/compact` built-in handler that POSTs `/compact`.
- [ ] 9.2 Render `compaction_started` as an inline "compacting…" spinner; clear on `compaction_finished`.
- [ ] 9.3 Surface the `tokensBefore → tokensAfter` delta in a one-line confirmation.
- [ ] 9.4 Snapshot tests for the inline indicator.

## 10. Documentation / E2E

- [ ] 10.1 Write `COMPACTION.md`: summary format, configuration, tradeoffs.
- [ ] 10.2 E2E: synthetic conversation long enough to trigger threshold compaction against a stub model that returns a canned summary; assert section headers present, `<files>` block correct, tail preserved.
- [ ] 10.3 E2E: `/compact` manual trigger against a short session succeeds and emits the expected event pair.
- [ ] 10.4 E2E: invariant violation on bad config → CLI exits non-zero before creating a session.
