## Context

`wishlist.md` lays out the problem (compaction kills access to valuable tool outputs) and solution (store them under retrieval IDs, give the model a `recall` tool). This design records the integration and storage choices.

## Goals / Non-Goals

**Goals:**

- Store is keyed by short, stable ID so referenced outputs survive re-compaction cycles.
- `recall` is a normal tool — no special permission, no session state mutation.
- Zero ceremony for the model: it already sees the retrieval stub in the preserved message; calling `recall` is the natural next step when it needs the content.

**Non-Goals:**

- Distributed / shared recall stores across sessions. Each session has its own.
- Summarization on recall (recall returns stored content, possibly line-sliced). A "recall-summary" variant is a future enhancement.
- Cross-session pruning (a subagent pulling data from a parent's store). `wishlist.md` flags this as a later consideration; out of scope here.

## Decisions

### D1. SQLite per session, not a single shared DB

**Decision:** One `~/.chimera/recall/<sessionId>.sqlite` per session. Schema: `entries(id TEXT PRIMARY KEY, created_at INTEGER, tool_name TEXT, args_json TEXT, content TEXT, byte_len INTEGER)`.

**Why:** Session-scoped storage matches session-scoped lifecycle — deleting a session (`chimera sessions rm <id>`) deletes the store in one step. A single shared DB would force multi-tenant key management and cross-session isolation concerns we don't need yet.

**Cost:** Disk overhead per session. SQLite's WAL files are small; acceptable.

### D2. Archival happens at compaction boundary, not per-tool-call

**Decision:** `add-compaction` exposes `onBeforeReplace(messages) → messages`. The recall package registers a hook that walks the to-be-replaced slice, extracts large `tool-result` contents, writes them to the store, and rewrites the messages in place before returning them to the compactor.

**Why:** Archiving on every tool call is wasteful — most outputs never get pruned. Archiving at the compaction boundary is O(pruned outputs) and integrates naturally.

**Cost:** Recall is useless without compaction. Documented.

### D3. Retrieval IDs are `pr_<8-char-hash>`

**Decision:** `pr_` prefix + first 8 hex chars of a SHA-256 over `tool_name + JSON.stringify(args) + contentHash`. If a collision occurs on insert, extend to 12 chars.

**Why:** Short enough to fit in the stub, stable so re-compactions of the same content produce the same ID (dedup for free in the `INSERT OR IGNORE` path).

### D4. `recall` tool supports slicing

**Decision:** `recall({ id, start_line?, end_line?, search? })`. If `search` is provided, return only the lines matching that substring (case-sensitive). If `start_line`/`end_line` are provided, return that slice. Default returns the full content, truncated to a configurable hard cap (default 100 KB) with a `truncated: true` flag.

**Why:** Mirrors the `read` tool's slicing for predictability. Very large recalled outputs should not re-blow the context window they were pruned to save.

### D5. No permission prompt on recall

**Decision:** `recall` is not gated by `PermissionGate`. The data was already approved when the original tool ran.

**Why:** Prompting again would be surprising and is strictly redundant.

### D6. Stub format carries enough context to be useful even without recall

**Decision:** The stub replaces the tool result content but leaves the preceding `tool-call` intact (with its args). So the model sees "I called `read({ path: 'config.ts' })`; result archived as `pr_abc123`". It has the semantic context of what was read without recalling.

**Why:** Matches `wishlist.md`'s worked example. Many "recall" decisions can be made from the args alone (the model doesn't always need the content).

### D7. GC on age, not size

**Decision:** Delete entries whose `created_at` is older than `recall.ttlDays` (default 30). Runs opportunistically when the store is opened for a write.

**Why:** Simple and predictable. Size-based eviction would need LRU tracking and hurts reproducibility of older sessions.

## Risks / Trade-offs

- **[Content hashing on every tool result during archival]** → only happens at compaction time, not per-call. Acceptable.
- **[Recall ID in the stub pollutes the preserved summary]** → stubs are short (~60 chars); compaction's summary prompt does NOT summarize away the stub text.
- **[SQLite-native on some distros needs build tools]** → document; fall back to a JSON file store via a future `--recall-backend file` flag if users report issues.

## Migration Plan

Additive. Users who also have `add-compaction` installed get recall working immediately. Users without `add-compaction` have the `recall` tool available but never have archived content; that's benign.

## Open Questions

- Should `recall` appear in the tool list from session start (our choice) or only after the first archival (saves a handful of tokens in the tool schema block)? We chose always-present — the schema is small and conditional registration is fragile.
- Should `recall` support multi-ID retrieval in one call (`ids: string[]`)? Proposed: no; one-at-a-time keeps the tool result size bounded. Revisit if the model ends up issuing many sequential recalls.
