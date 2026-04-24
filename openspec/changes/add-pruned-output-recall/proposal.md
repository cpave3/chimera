## Why

`wishlist.md` §Retrievable pruned tool outputs describes a concrete improvement over naive compaction: instead of replacing old tool outputs with a dead-end placeholder (forcing the model to re-run the tool with possibly-different results), archive the output to a keyed store and leave behind a retrieval stub plus a `recall` tool. This preserves access to non-deterministic, expensive, or transient outputs while keeping the context window small. It composes cleanly with `add-compaction`: compaction replaces old messages with a structured summary, and the tool outputs referenced within that window become recallable.

## What Changes

- Introduce `@chimera/recall` with a document-store abstraction (`RecallStore`) defaulting to a local SQLite-backed implementation at `~/.chimera/recall/<sessionId>.sqlite`.
- Add a built-in `recall` tool that accepts `{ id: string, start_line?: number, end_line?: number, search?: string }` and returns the stored output (optionally line-sliced or grep-filtered).
- When compaction runs (`add-compaction`), intercept the messages it is about to replace and extract every `tool-result` above a configurable size threshold (default 500 tokens) before replacement. Write each to the store with a short ID (`pr_<8-char-hash>`), rewrite the message in place so the result text becomes `[Result archived — retrieve with: recall({ id: "pr_abc123de" })]`, and THEN let compaction proceed over the (slimmer) message array.
- Skip archiving small outputs that fit cleanly in the summary.
- Register the `recall` tool unconditionally in `buildTools(ctx)` so the model has it from turn 1 (otherwise it wouldn't know to call it when the first pruning event happens).
- Garbage-collect entries older than `recall.ttlDays` (default 30) and also delete the store file on `chimera sessions rm <id>`.

## Capabilities

### New Capabilities

- `pruned-output-recall`: document store, `recall` tool, compaction-time archival intercept, TTL + cleanup.

### Modified Capabilities

None. The integration with compaction lives inside the `pruned-output-recall` capability via an "archival hook" that `add-compaction` exposes for this purpose (see Impact). No MVP or `add-compaction` requirement changes.

## Impact

- **Prerequisites**: `chimera-mvp` applied and archived. `add-compaction` strongly recommended but not strictly required — without it the archival hook never fires, meaning the `recall` tool is present but unused. Users who want recall without compaction would need to manually invoke archival, which we don't document as a supported mode.
- **Code changes outside the new package**:
  - `@chimera/compaction`: add an `onBeforeReplace(messages) → messages` hook that `add-pruned-output-recall` wires into. This is a small, additive surface — keep it as a simple pre-transform list.
  - `@chimera/tools`: register `recall` in `buildTools`; unit test that schema errors on missing `id`.
  - `@chimera/core`: no changes — tool execution is unchanged.
  - `@chimera/cli`: add `chimera sessions rm <id>` deletion to also drop the `~/.chimera/recall/<id>.sqlite` file if present.
- **Dependencies**: `better-sqlite3` (synchronous, battery-included). Added to `@chimera/recall` only.
- **Filesystem**: `~/.chimera/recall/<sessionId>.sqlite` per session; `<sessionId>.sqlite-wal` / `-shm` SQLite sidecars.
