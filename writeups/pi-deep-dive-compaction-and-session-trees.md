# Pi Coding Agent — Deep Dive: Compaction & Session Tree Branching

> This document goes deep into the two most architecturally interesting systems in the Pi coding agent: context compaction (how it manages long conversations within LLM context limits) and the session tree (how it stores conversations as branching, append-only DAGs with navigation and summarization). These are the systems most worth studying when building our own agent.

## Part 1: Context Compaction

### Overview

The compaction system solves the fundamental problem of long-running agent sessions: the context window fills up. Pi's approach is to use the LLM itself to summarize older messages into a structured checkpoint, then replace the old messages with the summary. The key design decisions are:

1. **Structured summaries** — not free-form, but a fixed format (goal, progress, decisions, next steps)
2. **Iterative updates** — each compaction builds on the previous summary rather than re-summarizing everything
3. **File operation tracking** — compaction summaries carry forward which files were read/modified, so the LLM knows what it has touched even after history is compressed
4. **Split-turn handling** — when the cut point falls mid-turn, a separate prefix summary is generated

### When Compaction Triggers

Two trigger paths in `agent-session.ts`:

**Threshold-based** (after every agent turn):
```
contextTokens > contextWindow - reserveTokens
```
With defaults: triggers when tokens exceed `contextWindow - 16384`. On a 200K model, that's ~183K tokens. Does not auto-retry — the user continues manually.

**Overflow-based** (on context overflow error from the LLM):
The LLM returns an error saying context is too large. The agent removes the error message, compacts, and auto-retries. A flag (`_overflowRecoveryAttempted`) prevents infinite loops — if overflow happens again after one compact-and-retry, it gives up.

### Token Estimation

Pi uses a simple heuristic rather than a real tokenizer:

```typescript
function estimateTokens(message: AgentMessage): number {
    // For all text-based content: chars / 4 (rounded up)
    // For images: 4800 chars (≈1200 tokens)
    // For tool calls: name.length + JSON.stringify(arguments).length, then / 4
    // Includes thinking blocks in assistant messages
}
```

When actual usage data is available from the last LLM response, it's used as the baseline. Only messages _after_ that response are estimated. This hybrid approach (`real usage + trailing estimates`) is more accurate than pure estimation.

```typescript
function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
    const usageInfo = getLastAssistantUsageInfo(messages);
    if (!usageInfo) {
        // No usage data — estimate everything
        return { tokens: sumEstimates(messages), ... };
    }
    // Real data + estimate trailing messages
    const usageTokens = calculateContextTokens(usageInfo.usage);
    let trailingTokens = 0;
    for (let i = usageInfo.index + 1; i < messages.length; i++) {
        trailingTokens += estimateTokens(messages[i]);
    }
    return { tokens: usageTokens + trailingTokens, ... };
}
```

### Finding the Cut Point

The `findCutPoint()` algorithm determines where to split history into "summarize" vs "keep":

1. Walk backward from the end of the session, accumulating estimated tokens
2. When accumulated tokens >= `keepRecentTokens` (default 20K), stop
3. Snap to the nearest **valid cut point** — can only cut at user, assistant, custom, or bashExecution messages (never at toolResult, which must stay with its tool call)
4. If the cut falls mid-turn (at an assistant message rather than a user message), record this as a "split turn" and find the turn's start index

```
Messages:  [user] [assistant+tools] [toolResult] [toolResult] [user] [assistant] ...
                                                                ^
                                                          Valid cut points
                                              (never here — tool results must follow tool calls)
```

The split-turn detection matters because if you cut between a user's request and the assistant's partial work on it, you need to summarize what was done in the first half of the turn separately.

### The Summarization Prompts

Three prompts, used in different scenarios:

**SUMMARIZATION_PROMPT** — for first-time summaries (no previous compaction):

```
Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks/changes]
### In Progress
- [ ] [Current work]
### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]

Keep each section concise. Preserve exact file paths, function names, and error messages.
```

**UPDATE_SUMMARIZATION_PROMPT** — when a previous summary exists (iterative update):

Same structure, but prefixed with rules about preserving existing information:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished

The previous summary is included in `<previous-summary>` tags in the prompt.

**TURN_PREFIX_SUMMARIZATION_PROMPT** — for the first half of a split turn:

```
This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]
```

### The Compaction Pipeline

**Step 1: Prepare** (`prepareCompaction()`):
1. Find the latest compaction entry in the session path (if any)
2. Extract previous summary text and boundary
3. Estimate total context tokens
4. Find the cut point using the algorithm above
5. Split messages into: `messagesToSummarize` (will be replaced) and `turnPrefixMessages` (if split turn)
6. Extract file operations from tool calls in the messages being summarized

**Step 2: Compact** (`compact()`):
1. If **split turn**: generate two summaries in parallel:
   - History summary (main, 80% of token budget = ~13K tokens with default settings)
   - Turn prefix summary (50% of token budget = ~8K tokens)
   - Merge: `"{history}\n\n---\n\n**Turn Context (split turn):**\n\n{prefix}"`
2. If **normal**: just the history summary
3. Choose prompt: `UPDATE_SUMMARIZATION_PROMPT` if previous summary exists, else `SUMMARIZATION_PROMPT`
4. Serialize the conversation into tagged text (not as LLM messages — wrapping in `<conversation>` tags prevents the model from treating it as a conversation to continue)
5. Call `completeSimple()` with the model

**Step 3: Track file operations**:
```typescript
function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
    const modified = new Set([...fileOps.edited, ...fileOps.written]);
    const readOnly = [...fileOps.read].filter(f => !modified.has(f)).sort();
    return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}
```
- `readFiles` = files that were only read, never written/edited
- `modifiedFiles` = union of written and edited files
- These are accumulated across compactions (each compaction carries forward the previous one's lists)

Appended to the summary as XML:
```xml
<read-files>
path/to/file1
path/to/file2
</read-files>

<modified-files>
path/to/modified
</modified-files>
```

**Step 4: Persist** — stored as a `CompactionEntry` in the session tree with summary, firstKeptEntryId, tokensBefore, and details (file lists).

### What the LLM Sees After Compaction

When `buildSessionContext()` encounters a compaction entry in the path:

1. A `CompactionSummaryMessage` with preamble: "The conversation history before this point was..."
2. Messages from `firstKeptEntryId` to the compaction (the "kept" recent messages)
3. All messages after the compaction

Everything before `firstKeptEntryId` is gone from context — replaced by the summary.

### Extension Hooks

Extensions can intercept compaction via `session_before_compact`:
- Provide their own summary (bypassing the default summarizer)
- Add custom details to the compaction entry
- Use a different model or prompt for summarization

---

## Part 2: Session Tree Branching

### The Data Model

Sessions are stored as **append-only JSONL files** where each line is a JSON object. The first line is always a `SessionHeader`:

```json
{"type":"session","version":3,"id":"<uuid>","timestamp":"2025-04-22T...","cwd":"/home/user/project"}
```

Every subsequent entry has an `id` and `parentId`, forming a **directed acyclic graph (DAG)**:

```typescript
interface SessionEntryBase {
    type: string;
    id: string;           // 8-hex-char unique within session
    parentId: string | null;  // null = root entry
    timestamp: string;    // ISO 8601
}
```

### Entry Types

| Type | Purpose | In LLM Context? |
|------|---------|-----------------|
| `message` | User, assistant, toolResult, bashExecution, custom messages | Yes |
| `compaction` | Summary of compressed history | Yes (as CompactionSummaryMessage) |
| `branch_summary` | Summary of abandoned branch | Yes (as BranchSummaryMessage) |
| `custom_message` | Extension-injected messages | Yes (converted to user message) |
| `thinking_level_change` | Records thinking level changes | No (settings only) |
| `model_change` | Records model switches | No (settings only) |
| `label` | User bookmarks on entries | No (metadata) |
| `session_info` | Display name for session | No (metadata) |
| `custom` | Extension state persistence | No (extension data) |

### How the Tree Works

A linear conversation is a simple chain:

```
user(abc) → assistant(def) → user(ghi) → assistant(jkl)
               parentId:abc      parentId:def    parentId:ghi
```

Branching creates a fork — two entries share the same parent:

```
user(abc) → assistant(def) → user(ghi) → assistant(jkl)     [branch A]
                            ↘ user(mno) → assistant(pqr)     [branch B]
```

Both `ghi` and `mno` have `parentId: def`. The `leafId` tracks which branch is "current".

**Key invariant**: entries are never modified or deleted. Branching only moves the leaf pointer and creates new entries.

### Persistence Strategy

Entries are buffered in memory until the first assistant response arrives, then flushed to disk. This avoids creating session files for abandoned conversations (user types something, then cancels).

Subsequent entries are appended one at a time via `appendFileSync`. The JSONL format means each line is independent — no need to parse or rewrite the whole file to add an entry.

When forking creates a new session, the file is rewritten from the filtered entry set.

### Path Resolution: From Tree to Linear Context

`buildSessionContext()` converts the tree into a linear message array for the LLM:

1. Start at the current `leafId`
2. Walk up the parent chain to the root, collecting entries
3. Reverse to chronological order
4. Extract settings (thinking level, model) by scanning the path
5. Handle compaction: if a compaction entry exists on the path, emit its summary followed by only the kept and post-compaction messages
6. Convert entry types to message types: `message` → direct, `branch_summary` → BranchSummaryMessage, `custom_message` → user message

The LLM sees a clean linear history, unaware that it's one path through a larger tree.

### Branch Navigation

When a user navigates to a different point in the tree (`navigateTree()`):

**Step 1: Collect entries to summarize**

Uses `collectEntriesForBranchSummary()`:
1. Get all entries on the old branch (current leaf to root) as a Set
2. Get all entries on the target branch
3. Find the common ancestor (deepest shared node)
4. Walk from old leaf back to common ancestor, collecting entries being abandoned

**Step 2: Generate branch summary** (optional)

If summarization is requested, `generateBranchSummary()`:
1. Calculates a token budget: `contextWindow - reserveTokens`
2. Walks the collected entries newest-first, accumulating under budget
3. Special case: compaction and branch_summary entries can exceed budget up to 90% (they're high-value context)
4. Serializes to text, calls the LLM with the branch summary prompt
5. Prepends preamble: "The user explored a different conversation branch before returning here."
6. Appends file operation tracking (same XML format as compaction)

**Step 3: Move the leaf**

Three modes depending on the target:
- **User message**: leaf moves to its parent (the message text goes into the editor for re-typing)
- **Custom message**: same as user message
- **Non-user message**: leaf moves to that entry directly

If a summary was generated, it's stored as a `BranchSummaryEntry` child of the new leaf position.

**Step 4: Rebuild context**

`buildSessionContext()` re-resolves the path from the new leaf, producing an updated message array for the agent.

### Branch Summarization Prompt

```
Create a structured summary of this conversation branch for context when returning later.

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]
### In Progress
- [ ] [Work that was started but not finished]
### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]
```

The summary is injected into the new branch as a user-role message, so the LLM knows what was tried and abandoned.

### Forking vs Branching

Two distinct operations:

**Branching** (`branch()` / `navigateTree()`):
- Moves the leaf pointer within the same session file
- Old branches remain accessible in the tree
- Optionally generates a summary

**Forking** (`createBranchedSession()`):
- Creates a **new session file** containing only one path (root to specified leaf)
- The new file's header has `parentSession` pointing to the source file
- Labels are copied and re-parented
- Old session file is unchanged
- Result is a clean, linear session file with no branches

### Tree Visualization

The `TreeSelectorComponent` (1247 lines) flattens the tree for terminal display:

- **Connectors**: `├─`, `└─` for branch points; `│` for continuation
- **Fold markers**: `⊞` for collapsed branches, `⊟` for expandable roots
- **Active path highlighting**: `•` marks entries on the current leaf's path
- **Labels**: colored `[label]` badges on bookmarked entries
- **Filter modes**: `default` (hide settings), `no-tools`, `user-only`, `labeled-only`, `all`
- **Search**: space-separated tokens, all must match (AND logic)
- **Navigation**: up/down, page up/down, Ctrl+arrows to jump between branch segments

### Session File Format Example

```jsonl
{"type":"session","version":3,"id":"abc123","timestamp":"2025-04-22T10:00:00.000Z","cwd":"/home/user/project"}
{"type":"message","id":"a1","parentId":null,"timestamp":"2025-04-22T10:00:01.000Z","message":{"role":"user","content":"Fix the login bug"}}
{"type":"message","id":"a2","parentId":"a1","timestamp":"2025-04-22T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"I'll look into it..."},{"type":"toolCall","name":"read","arguments":{"path":"src/auth.ts"}}]}}
{"type":"message","id":"a3","parentId":"a2","timestamp":"2025-04-22T10:00:06.000Z","message":{"role":"toolResult","toolCallId":"tc_1","toolName":"read","content":"..."}}
{"type":"message","id":"a4","parentId":"a3","timestamp":"2025-04-22T10:00:10.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Found the issue..."}]}}
{"type":"branch_summary","id":"b1","parentId":null,"timestamp":"2025-04-22T10:05:00.000Z","fromId":"a1","summary":"The user explored a different conversation branch...\n\n## Goal\nFix login bug\n\n## Progress\n### Done\n- [x] Read auth.ts\n- [x] Identified issue\n\n## Key Decisions\n- **Root cause**: session token not refreshed on redirect"}
{"type":"message","id":"c1","parentId":"b1","timestamp":"2025-04-22T10:05:01.000Z","message":{"role":"user","content":"Actually, fix the signup flow instead"}}
```

In this example, the user navigated back to the root and started a new branch. The summary captures what was done in the abandoned branch. The new conversation ("fix the signup flow") starts after the summary.

### Version Migration

Sessions auto-migrate on load:

- **v1 → v2**: Adds `id`/`parentId` tree structure. Entries get auto-generated IDs and are linked sequentially. Compaction entries get their index-based references converted to ID-based.
- **v2 → v3**: Renames `hookMessage` role to `custom` for consistency.

If migrations are applied, the file is rewritten in place.

---

## Design Analysis

### What Works Well

**Structured summaries over free-form**: The fixed format (Goal / Constraints / Progress / Decisions / Next Steps / Critical Context) ensures compaction summaries are actually useful. A free-form summary might focus on the wrong things or omit critical state.

**Iterative update**: Using `UPDATE_SUMMARIZATION_PROMPT` to build on the previous summary rather than re-summarizing everything means information compounds rather than being repeatedly lossy-compressed.

**File operation tracking across compactions**: After 5 compactions, the LLM still knows every file it has touched. This is a subtle but important detail — without it, the LLM might re-read files it already modified or forget what it changed.

**Append-only immutability**: Never modifying or deleting entries eliminates a whole class of bugs (concurrent access, partial writes, corruption). Branching is just pointer movement.

**Branch summaries as context**: When you abandon a branch and come back later, the LLM knows what was tried. This prevents repeated dead ends and lets it learn from failed approaches.

### What Could Be Better

**Token estimation accuracy**: `chars / 4` is a rough heuristic. For code-heavy sessions (lots of punctuation, special characters), this overestimates significantly. For CJK text, it underestimates. A lightweight tokenizer (even a vocabulary-based approximation) would improve compaction timing.

**Fixed keepRecentTokens**: The 20K default is the same regardless of task complexity. A complex refactoring task might benefit from keeping more recent context, while a simple Q&A session could compact more aggressively.

**No selective compaction**: The system compacts everything before the cut point. It can't say "keep this important early message but compress the rest." A priority-based system (e.g., messages the LLM referenced recently get higher keep priority) could produce better summaries.

**Summary-of-summaries degradation**: After many compactions, the UPDATE_SUMMARIZATION_PROMPT iteratively builds on previous summaries. Each iteration is lossy, so after 10+ compactions, early session context may be severely degraded. There's no mechanism to detect or correct this.

**Branch summary budget**: Fixed at 2048 max tokens. For long branches with significant work, this may be too small. The compaction budget is proportional to reserveTokens, but branch summaries aren't.

### Key Takeaways for Our Agent

1. **Use structured summary prompts, not free-form.** The Goal/Progress/Decisions/Next Steps format is directly useful to the LLM. Design the format to match what the LLM needs to decide its next action.

2. **Track file operations across compactions.** This is easy to implement (just accumulate Sets from tool calls) and prevents the agent from losing track of what it has touched.

3. **Append-only JSONL is a pragmatic persistence format.** Simple, crash-safe (each line is independent), human-readable, and git-diffable. The tree structure via id/parentId is elegant and avoids the complexity of a database.

4. **Branch summarization is worth the LLM call.** When the user changes direction, capturing what was tried prevents wasted effort. Consider making this automatic rather than opt-in.

5. **The split-turn problem is real.** When the cut point falls mid-turn, you need special handling. Pi's approach (separate prefix summary merged into the main summary) is reasonable but adds complexity. An alternative: always cut at turn boundaries, even if it means keeping slightly more or less than the target.
