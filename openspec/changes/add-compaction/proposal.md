## Why

`chimera-mvp` documents as a known limit that "sessions that exceed the context window error and end. Compaction lands in a follow-on change." `goal.md` makes structured compaction a core principle ("structured compaction over naive truncation. Track file operations across compactions. Use structured prompts (goal, progress, decisions, next steps) so the LLM can pick up where it left off."). This change makes long sessions usable without forcing the user to re-start.

## What Changes

- Introduce `@chimera/compaction` with a `Compactor` abstraction that takes a `Session` snapshot and returns a compacted `Message[]` plus a persisted `CompactionSummary`.
- Implement **structured** compaction (not blind truncation): produce a summary with the fields Goal / Constraints / Progress (Done, In Progress, Blocked) / Key Decisions / Next Steps / Critical Context per `goal.md` §Compaction, plus a `<files>` block listing all files read or modified since session start (accumulated across compactions).
- Trigger compaction when estimated token count exceeds `contextWindow - reserveTokens` (config: `compaction.reserveTokens`, default 16384; `compaction.keepRecentTokens` default 20000).
- Preserve the last `keepRecentTokens` worth of recent messages verbatim; replace everything older with a single synthetic assistant message carrying the structured summary.
- Persist each compaction event to `~/.chimera/sessions/<id>.compactions.jsonl` as an append-only log so history is inspectable and replayable.
- Emit `compaction_started`, `compaction_finished { summary, tokensBefore, tokensAfter }` events on the session stream so consumers can render progress.
- Expose a `/compact` built-in TUI slash command to trigger compaction manually.
- Add config keys `compaction.enabled` (default true), `compaction.reserveTokens`, `compaction.keepRecentTokens`, `compaction.model` (defaults to the session model; can be overridden to a cheaper model for summary generation).

## Capabilities

### New Capabilities

- `context-compaction`: threshold trigger, structured summary generation, recent-tail preservation, file-operation tracking, persisted compaction log, event emission, `/compact` built-in.

### Modified Capabilities

None formally. `@chimera/core`'s agent loop gains a compaction check before each model call; this is an additive hook, not a requirement change to MVP specs. All new behaviors are captured in the `context-compaction` capability.

## Impact

- **Prerequisites**: `chimera-mvp` applied and archived.
- **Code changes outside the new package**:
  - `@chimera/core`: at the top of each step, before calling `streamText`, invoke `compactor.maybeCompact(session)`; if compaction runs, replace `session.messages` with the returned array and emit the compaction events.
  - `@chimera/core`: track file operations per session (list of paths read/modified) so the summary's `<files>` block is accurate across compaction cycles.
  - `@chimera/tui`: render `compaction_started` as an inline indicator; render `compaction_finished` with `tokensBefore` → `tokensAfter`.
  - `@chimera/cli` + `@chimera/tui`: add `/compact` built-in that calls a new `POST /v1/sessions/:id/compact` server endpoint.
  - `@chimera/server`: expose `POST /v1/sessions/:id/compact` (force-run compaction) and include a `compactionCount` + `lastCompactedAt` on `GET /v1/sessions/:id`.
- **Filesystem**: `~/.chimera/sessions/<id>.compactions.jsonl` per session.
- **Cost**: each compaction is one additional model call. Using a cheaper model for summaries (`compaction.model`) is supported.
