## ADDED Requirements

### Requirement: Per-session recall store

`@chimera/recall` SHALL provide a `RecallStore` with SQLite backing at `~/.chimera/recall/<sessionId>.sqlite`. The schema SHALL include a table named `entries` with at minimum: `id TEXT PRIMARY KEY`, `created_at INTEGER`, `tool_name TEXT`, `args_json TEXT`, `content TEXT`, `byte_len INTEGER`.

The store SHALL be created lazily on first write. `chimera sessions rm <id>` SHALL delete the store file(s) along with the session snapshot.

#### Scenario: Store created on first put

- **WHEN** a session has never archived anything and `store.put(entry)` is called for the first time
- **THEN** `~/.chimera/recall/<sessionId>.sqlite` SHALL exist afterwards with the `entries` table populated by one row

#### Scenario: Session deletion removes the store

- **WHEN** a user runs `chimera sessions rm <id>` and a recall store existed for that session
- **THEN** `~/.chimera/recall/<id>.sqlite` (and any WAL / SHM sidecars) SHALL not exist afterwards

### Requirement: Retrieval ID format

`RecallStore.put(entry)` SHALL compute the entry's `id` as `"pr_" + first 8 hex chars of SHA-256(toolName + "|" + canonicalJSON(args) + "|" + sha256(content))`. If the 8-character prefix collides with an existing entry that has different content, the ID SHALL be extended to 12 characters and retried.

IDs SHALL be deterministic: inserting the same `{toolName, args, content}` tuple twice SHALL yield the same ID and SHALL be idempotent (the second insert MAY be a no-op).

#### Scenario: Deterministic ID

- **WHEN** the same `{toolName, args, content}` tuple is passed to `put` twice
- **THEN** both calls SHALL return the same `id` and the store SHALL contain exactly one row for that id

### Requirement: `recall` tool

`@chimera/tools` SHALL register a `recall` tool that accepts `{ id: string, start_line?: number, end_line?: number, search?: string }` and returns `{ content: string, total_lines: number, truncated: boolean, tool_name: string, args: unknown }`.

- If `id` does not exist in the current session's store, the tool SHALL return `{ content: "", total_lines: 0, truncated: false, error: "no entry for <id>" }`.
- If `search` is provided, only lines (case-sensitively) containing the substring SHALL be returned.
- If `start_line` / `end_line` are provided, only that line range SHALL be returned.
- `content` SHALL be hard-capped at 100 KB; if the filtered content exceeds that, `truncated` SHALL be `true`.

`recall` SHALL NOT require permission approval regardless of `AutoApproveLevel`.

#### Scenario: Line-range recall

- **WHEN** the model calls `recall({ id: "pr_abc12345", start_line: 10, end_line: 12 })` on an entry containing at least 12 lines
- **THEN** the returned `content` SHALL contain exactly those three lines, `total_lines` SHALL equal the entry's total line count, and no permission prompt SHALL occur

#### Scenario: Search filter

- **WHEN** `recall({ id, search: "ERROR" })` is called on an entry whose content has 5 lines containing `ERROR` and 20 that do not
- **THEN** `content` SHALL contain exactly those 5 matching lines (in original order)

#### Scenario: Missing ID

- **WHEN** the model calls `recall({ id: "pr_doesnotexist" })`
- **THEN** the tool result SHALL carry `{ error: "no entry for pr_doesnotexist", content: "" }` and SHALL NOT throw

### Requirement: Compaction-time archival

`@chimera/recall` SHALL register a hook with `@chimera/compaction`'s `onBeforeReplace(messages) → messages` extension point. The hook SHALL:

1. Walk the slice of messages the compactor is about to replace.
2. For each `tool-result` whose text content exceeds `recall.archiveThresholdTokens` (default: 500 tokens, estimated as `length/4`), call `store.put({ toolName, args, content })` and replace the message's result content with `[Result archived — retrieve with: recall({ id: "<id>" })]`.
3. Leave the preceding `tool-call` message unchanged so the model retains the semantic context of what was called with which args.
4. Return the modified messages array; compaction then proceeds normally over the slimmer slice.

If `@chimera/compaction` is not installed, this hook SHALL NOT fire and `recall` SHALL remain a no-op surface (present but never populated).

#### Scenario: Large tool-result archived during compaction

- **WHEN** a compaction pass encounters a `tool-result` with 3 KB of content in its to-be-replaced slice, with a threshold of 500 tokens
- **THEN** the store SHALL contain a new entry with that content, the message in the pre-compaction slice SHALL have been rewritten to the retrieval stub, and the compactor's summary SHALL see only the stub

#### Scenario: Small tool-result not archived

- **WHEN** a `tool-result` with 50 bytes of content is in a to-be-replaced slice
- **THEN** the store SHALL NOT be written to for that result and the message's content SHALL pass unchanged to the compactor

### Requirement: TTL and cleanup

`RecallStore` SHALL delete entries whose `created_at` is older than `recall.ttlDays` days (default 30). Cleanup SHALL run opportunistically when the store is opened for a write; a full-store scan at open time is acceptable for MVP of this capability.

`chimera sessions rm <id>` SHALL remove the store file(s) as noted above regardless of TTL.

#### Scenario: Old entries expire

- **WHEN** the store is opened on a day when some entries have `created_at < now - ttlDays` and then a new `put` is performed
- **THEN** those old entries SHALL no longer appear in `store.get(theirId)` after the put completes

### Requirement: Configuration

`@chimera/cli` SHALL honor these keys under `recall` in `~/.chimera/config.json`:

- `archiveThresholdTokens: number` — default `500`.
- `ttlDays: number` — default `30`.
- `maxRecallBytes: number` — default `102400` (100 KB hard cap on the `recall` tool's returned content).
- `enabled: boolean` — default `true`. When `false`, the `recall` tool is NOT registered and the compaction hook SHALL NOT be installed.

#### Scenario: Recall disabled

- **WHEN** `recall.enabled` is `false` in config and a session starts
- **THEN** the tool registry SHALL NOT contain `recall`, the compaction hook SHALL NOT fire, and no SQLite file SHALL be created for that session
