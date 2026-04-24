## ADDED Requirements

### Requirement: Compaction trigger

Before each agent-loop step, `@chimera/core` SHALL invoke `compactor.maybeCompact(session)`. The compactor SHALL estimate the token count of `session.messages` and, if the estimate exceeds `contextWindow - compaction.reserveTokens`, SHALL run a compaction pass before the step executes.

Users SHALL also be able to force a compaction at any time via `POST /v1/sessions/:id/compact`, regardless of estimated token count.

If `compaction.enabled` is `false` in config, `maybeCompact` SHALL always be a no-op.

#### Scenario: Proactive compaction before overflow

- **WHEN** `session.messages` estimates to `contextWindow - 10000` tokens and `reserveTokens` is `16384`
- **THEN** compaction SHALL run before the next `streamText` call and the resulting messages array SHALL estimate below the threshold

#### Scenario: Disabled by config

- **WHEN** `compaction.enabled` is `false` and the session estimate exceeds the threshold
- **THEN** `maybeCompact` SHALL return the session unchanged and the loop SHALL proceed; overflow errors from the provider SHALL surface as `tool_call_error` or `run_finished { reason: "error" }` as before

### Requirement: Structured summary format

The compaction summary SHALL be a single synthetic message with role `"assistant"` whose content contains, in order, sections with these literal markdown headers: `## Goal`, `## Constraints`, `## Progress`, `### Done`, `### In Progress`, `### Blocked`, `## Key Decisions`, `## Next Steps`, `## Critical Context`, followed by a `<files>` XML block.

The `<files>` block SHALL list every file path the session has touched (across all prior compactions), grouped as `<read>` (paths passed to the `read` tool) and `<modified>` (paths passed to `write` or `edit`). A path SHALL appear under `<modified>` only (not also `<read>`) if it was ever written, even if it was read first.

Each section MAY be empty but its header SHALL still be present so downstream compactions can parse the summary idempotently.

#### Scenario: Summary structure stable across compactions

- **WHEN** two compaction cycles run in sequence on a session
- **THEN** both produced summaries SHALL contain all listed section headers in order, and the second summary's `<files>` block SHALL be a superset of the first's

#### Scenario: File moved from read to modified

- **WHEN** a session first reads `src/foo.ts` then later writes to it, and a compaction runs
- **THEN** the `<files>` block SHALL contain `<modified>src/foo.ts</modified>` and SHALL NOT contain `<read>src/foo.ts</read>`

### Requirement: Recent-tail preservation

The compactor SHALL compute `k` = the largest number of trailing messages whose estimated tokens sum to ≤ `compaction.keepRecentTokens`, then replace messages at indices `[0, n-k-1]` with the synthetic summary message, leaving indices `[n-k, n-1]` untouched.

If the resulting boundary would split an assistant message and its subsequent `tool-result`s (or vice versa), the boundary SHALL extend backward (into the to-be-compacted region) until the tail begins on a clean user-or-assistant boundary.

#### Scenario: Tool pair not split

- **WHEN** the tail boundary falls between an assistant `tool-call` and its matching `tool-result`
- **THEN** the boundary SHALL move earlier so that the preserved tail begins at or before the `tool-call`, and the compactor SHALL log the adjustment

### Requirement: File-operation tracking

`@chimera/core`'s session SHALL maintain a `fileOps: { reads: Set<string>, writes: Set<string> }` structure updated whenever the `read`, `write`, or `edit` tools complete successfully:

- `read` → add resolved absolute path to `reads`.
- `write` or `edit` → add resolved absolute path to `writes`.

`reads` and `writes` SHALL persist across compactions and SHALL be serialized in session snapshots. On deserialization, absent fields default to empty sets.

The compactor SHALL use `fileOps` to populate the `<files>` block, not by re-parsing tool call history.

#### Scenario: File path survives compaction

- **WHEN** the model read `src/foo.ts` at turn 3 and compaction runs at turn 50
- **THEN** the summary's `<files>` block SHALL contain `<read>src/foo.ts</read>` (or `<modified>...` if it was also written)

### Requirement: Compaction events

During compaction the session event stream SHALL emit, in order:

- `compaction_started { reason: "threshold" | "manual" }`
- `compaction_finished { summary: string, tokensBefore: number, tokensAfter: number, messagesReplaced: number }`

If compaction fails (model error, invariant violation), the stream SHALL emit `compaction_failed { error: string }` and the session messages SHALL remain unchanged — the agent loop then continues and, if the window is exceeded, the next step's model call SHALL surface the provider error as usual.

#### Scenario: Manual trigger emits correct reason

- **WHEN** a client POSTs to `/v1/sessions/:id/compact` and the compaction succeeds
- **THEN** the event stream SHALL contain `compaction_started { reason: "manual" }` followed by `compaction_finished`

### Requirement: Persisted compaction log

Each successful compaction SHALL append one JSON line to `~/.chimera/sessions/<sessionId>.compactions.jsonl` with at minimum:

```
{ ts: number, reason: "threshold"|"manual", tokensBefore, tokensAfter, summary, messagesReplaced: { count, firstIndex, lastIndex } }
```

The file SHALL be created on first compaction and SHALL NEVER be rewritten — it is append-only.

#### Scenario: Log replay is chronological

- **WHEN** a session has had three compactions
- **THEN** the `.compactions.jsonl` file SHALL have exactly three lines in the order the compactions occurred, and each `ts` SHALL be greater than or equal to the previous

### Requirement: `/compact` built-in

The TUI SHALL recognize `/compact` as a new built-in slash command that calls `POST /v1/sessions/:id/compact` on the active session and renders the subsequent `compaction_started`/`compaction_finished` events inline.

#### Scenario: Manual compact from TUI

- **WHEN** a user types `/compact` and presses Enter
- **THEN** a `compaction_started { reason: "manual" }` event SHALL be emitted within one event tick, and the TUI SHALL render an inline "compacting…" indicator that clears on `compaction_finished`

### Requirement: Configuration

`@chimera/cli` SHALL honor these keys under `compaction` in `~/.chimera/config.json`:

- `enabled: boolean` — default `true`.
- `reserveTokens: number` — default `16384`.
- `keepRecentTokens: number` — default `20000`.
- `model: string` — default: the session's model. Accepts the same `providerId/modelId` format.

If `reserveTokens + keepRecentTokens >= contextWindow` for the configured session model, `@chimera/cli` SHALL refuse to start with an error identifying the invariant violation.

#### Scenario: Invariant check

- **WHEN** a user runs Chimera with a model whose `contextWindow` is 128000 and a config of `{ reserveTokens: 80000, keepRecentTokens: 80000 }`
- **THEN** the CLI SHALL exit non-zero with stderr naming the violated invariant
