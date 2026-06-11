# Context Compaction

Compaction keeps long-running sessions alive by shrinking the conversation
before the context window overflows. It runs in two tiers:

1. **Prune** — large tool outputs in the old part of the conversation are
   archived to the recall store and replaced in place with
   `[Result archived — retrieve with: recall({ id: "pr_..." })]` stubs. Cheap
   (no LLM call), near-lossless (the `recall` tool fetches archived content
   back, with slicing), and the conversation skeleton survives. When pruning
   alone gets the estimate back under budget, a threshold compaction stops
   here (`strategy: "prune"`).
2. **Summarize** — if pruning isn't enough (or the compaction was manual),
   the oldest messages are replaced with a structured summary; the most
   recent turns stay verbatim.

## When compaction runs

| trigger | how |
|---------|-----|
| **Threshold** (automatic) | The agent projects the next prompt size as the provider's last reported `inputTokens` plus a char/4 estimate of messages appended since (pure estimate before the first usage report). When the projection crosses `min(contextWindow × thresholdPercent, contextWindow − reserve)` — where the reserve covers `maxOutputTokens` plus a growth margin — compaction runs. The check happens **at run start and between steps inside tool loops**, so a long agentic run compacts mid-run instead of dying on a window overflow. |
| **Manual** | Type `/compact` in the TUI (or call `POST /v1/sessions/:id/compact`). Manual compactions always run the full prune + summarize pipeline. |

A failed threshold compaction emits `compaction_failed` and the run continues
(degraded beats dead); further attempts are latched off until the next user
turn. If compaction is disabled via config or `--no-compaction`, an oversized
prompt will surface a provider error as usual.

## Summary format

The summary is a single synthetic `assistant` message with exactly these
sections in this order:

```markdown
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
  <modified>path2</modified>
</files>
```

Every header must appear even if its body is empty, so that later compactions
can parse the previous summary idempotently.

The `<files>` block is generated from the session's tracked file operations,
not by re-parsing tool history.

## Tail preservation

Compaction computes `k` = the largest number of trailing messages whose
estimated tokens fit inside `keepRecentTokens`. Everything before index `n - k`
is replaced by the summary; the tail stays verbatim.

If that boundary would split an assistant `tool-call` from its matching
`tool-result`, the boundary moves backward to include the full pair.

## File-operation tracking

`read`, `write`, and `edit` tool calls update the session's `fileOps` field
after successful completion:

- `read(path)` → `fileOps.reads.add(absPath)`
- `write(path)` or `edit(path)` → `fileOps.writes.add(absPath)`

The compactor deduplicates: a path that was both read and written appears as
`<modified>` only. `fileOps` persists across compactions and across session
resume.

## Configuration

All keys live under `compaction` in `~/.chimera/config.json`:

| key | type | default | meaning |
|---|------|---------|---------|
| `enabled` | boolean | `true` | Turn compaction on/off globally. |
| `thresholdPercent` | number | `85` | Compact when the projected prompt crosses this percentage of the window (must be 50–95). |
| `reserveTokens` | number | `16384` | Absolute safety floor below `contextWindow`. |
| `keepRecentTokens` | number | `20000` | Budget for the trailing verbatim tail. |
| `model` | string | *(session model)* | Model used to generate summaries, in `providerId/modelId` format. |

The prune tier is configured under `recall` (see the README): `enabled`
(default true), `archiveThresholdTokens` (default 500 — tool results above
this estimated size are archived), and `ttlDays` (default 30).

The CLI refuses to start when the config can't work: `thresholdPercent`
outside [50, 95], `reserveTokens + keepRecentTokens >= contextWindow`, or a
keep-tail + reserve that doesn't fit under the effective trigger (which would
make every compaction re-trigger immediately).

Disable for a single invocation with `--no-compaction`.

## Compaction log

Each successful compaction appends one JSON line to
`~/.chimera/sessions/<sessionId>.compactions.jsonl`:

```json
{
  "ts": 1715420000000,
  "reason": "threshold",
  "tokensBefore": 120000,
  "tokensAfter": 45000,
  "summary": "## Goal\n...",
  "messagesReplaced": { "count": 15, "firstIndex": 0, "lastIndex": 14 }
}
```

The file is append-only; it is never rewritten in place.

## Trade-offs

- **Summary quality varies by model** → use `compaction.model` to assign a
cheaper model to summarization while keeping the main session on a premium one.
- **Token estimator is conservative** → Chimera uses a `char/4` heuristic with
a per-message overhead. You may compact slightly early. A per-provider
estimator can be swapped in later without changing the API.
- **Summary itself consumes tokens** → each compaction inputs the previous
summary and asks the model to merge. There is no unbounded append-only growth.
- **No raw tool-output recall** → the summary is lossy. If you need to recall
pruned tool content later, that requires a separate feature (not in scope).
