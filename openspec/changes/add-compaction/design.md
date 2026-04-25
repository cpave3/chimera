## Context

Compaction is the difference between an agent that politely dies at 200K tokens and one that can carry a multi-day debugging thread. `goal.md` lays out the structured-summary approach (Pi-style). MVP left the door open by serializing full `CoreMessage[]` and persisting sessions as plain JSON; this change plugs compaction into the agent loop without reshaping persistence.

## Goals / Non-Goals

**Goals:**

- Compaction is **structured**: the model gets a checklist of what it has done, what it is doing, what it is blocked on, and what files it has touched — not a "summary of the above".
- File-operation tracking spans compaction cycles so "I read `auth.ts` earlier" remains true 10 compactions later.
- Consumers observe compaction as first-class events; the TUI can show a progress indicator.
- Users can force `/compact` at any time (e.g. before a focused task).

**Non-Goals:**

- Retrievable pruned tool outputs — that's a separate change (`add-pruned-output-recall`). This change replaces old content with a summary only; it does NOT preserve the raw outputs for later recall.
- Branching / forking across compactions.
- Automatic model selection for summary generation beyond a config override.
- Cross-session memory / knowledge accumulation — that's a `memory` capability pattern goal.md describes but is out of scope here.

## Decisions

### D1. Trigger on estimated token count before each step

**Decision:** Compact when `estimateTokens(session.messages) > contextWindow - reserveTokens`. The check runs before the next `streamText` call, not reactively after an overflow.

**Why:** Reactive triggers (catch 400-from-provider) add a retry round-trip and tie us to provider-specific error shapes. Proactive estimates are good enough; we err on the side of compacting slightly early.

**Estimator:** start with a conservative char/4 heuristic; swap in per-provider token counters later (no spec change).

**Note:** the `track-session-token-usage` change exposes `session.usage.totalTokens` (the provider-reported cumulative count) on every `usage_updated` event. Once that change lands, the trigger MAY prefer `session.usage.lastStep.inputTokens` (the just-sent prompt size) over the heuristic for the threshold check, falling back to the heuristic only when usage is absent. This is a follow-up tightening, not a prerequisite.

### D2. Structured summary with stable section headers

**Decision:** The summary is a single synthetic assistant message whose body has exactly these sections, in this order, with these literal headers:

```
## Goal
## Constraints
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context
<files>
  <read>path1</read>
  <read>path2</read>
  <modified>path3</modified>
</files>
```

**Why:** Stable headers let subsequent compactions ingest the previous summary as input and carry facts forward without re-asking the model to restate everything. `<files>` as XML tags mirrors what `goal.md` describes.

### D3. Keep a recent tail verbatim

**Decision:** Compute `k` = the number of trailing messages that fit within `keepRecentTokens`. Replace everything earlier with the summary. The boundary SHALL NOT split an assistant/tool pair; if the tail would start mid-pair, extend it backward to include the full pair.

**Why:** Full-fidelity context for the immediate recent turns preserves the model's ability to continue naturally. Splitting a tool pair would leave an orphaned `tool-result` or `tool-call` that some providers reject.

### D4. Summary generation is a separate model call

**Decision:** Compaction calls `streamText` (or a simpler `generateText`) with a dedicated prompt that passes the to-be-summarized messages plus any previous summary. The model used defaults to the session model but can be overridden via `compaction.model`.

**Why:** Lets users assign a cheaper model to summarization while keeping the main session on a premium model.

**Cost:** one additional model call per compaction. Acceptable.

### D5. File-operation tracking lives in core, not compaction

**Decision:** `@chimera/core`'s `Session` gains a non-spec-facing `fileOps: { reads: Set<string>, writes: Set<string> }` field (computed, serialized on snapshot). Every `read` / `write` / `edit` tool call updates it. Compaction's summary template consumes this set directly rather than re-parsing tool call history.

**Why:** Keeps file tracking fast (no re-parse) and correct across compactions. The tracking is independent of whether compaction ever runs.

### D6. Persist the compaction log

**Decision:** Append one JSON line per compaction to `~/.chimera/sessions/<id>.compactions.jsonl` with `{ ts, tokensBefore, tokensAfter, summary, messagesReplaced: { count, firstIndex, lastIndex } }`.

**Why:** Debuggability. Users can inspect "why did the agent forget X" by reading the log. Append-only avoids rewrite cost.

### D7. Manual `/compact` is a first-class path

**Decision:** `POST /v1/sessions/:id/compact` forces a compaction regardless of threshold. TUI surfaces this as `/compact`.

**Why:** Users routinely want to reset focus before a new task without losing history; the button is useful and cheap.

## Risks / Trade-offs

- **[Summary quality varies by model]** → `compaction.model` lets users pick; tests use a stub and rely on the structured schema, not prose quality.
- **[Token estimator drift across providers]** → documented; swappable estimator.
- **[Infinite compaction loop if `reserveTokens + keepRecentTokens > contextWindow`]** → validate at config load; refuse to start if invariant violated.
- **[Summary itself can grow across many compactions]** → each compaction inputs the previous summary and asks the model to merge; no append-only summary growth.

## Migration Plan

Additive. Sessions created before this change continue to work; compaction only triggers on the new code path going forward. Old persisted sessions are compatible because `fileOps` is optional on deserialization and defaults to empty.

## Open Questions

- Should we offer "hard compaction" (replace EVERYTHING older than N messages) as a separate mode for users who want aggressive trimming? Proposed: **no** in this change; `reserveTokens`/`keepRecentTokens` tuning covers it.
- How do we interact with subagents? Proposed: each subagent session compacts independently using its own threshold. Parents do not see child summaries beyond the `spawn_agent` tool result, which is already a single string.
