# Context Compaction

Compaction keeps long-running sessions alive by replacing the oldest messages
with a structured summary before the context window overflows.

## When compaction runs

There are two triggers:

| trigger | how |
|---------|-----|
| **Threshold** (automatic) | Before each model step, Chimera estimates the token count of the current conversation. If `estimate > contextWindow - reserveTokens`, compaction runs automatically. The result is a summary message plus the most recent turns kept verbatim. |
| **Manual** | Type `/compact` in the TUI (or call `POST /v1/sessions/:id/compact`). The server queues the compaction and emits `compaction_started { reason: "manual" }` → `compaction_finished` on the event stream. |

If compaction is disabled via config or `--no-compaction`, `maybeCompact` is a
no-op and the agent loop proceeds normally. An oversized prompt will then
surface a provider error as usual.

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
| `reserveTokens` | number | `16384` | Safety margin below `contextWindow`. |
| `keepRecentTokens` | number | `20000` | Budget for the trailing verbatim tail. |
| `model` | string | *(session model)* | Model used to generate summaries, in `providerId/modelId` format. |

If `reserveTokens + keepRecentTokens >= contextWindow`, the CLI refuses to
start with an error naming the violated invariant.

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
