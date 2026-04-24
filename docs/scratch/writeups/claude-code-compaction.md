# Claude Code — Context Window Compaction System

> Claude Code implements a six-layer compaction pipeline that progressively reclaims context window space, from lightweight per-message budgeting through cache-aware microcompaction to full LLM-summarised conversation collapse. Each layer targets a different cost/quality tradeoff and is gated independently via feature flags and GrowthBook experiments, allowing Anthropic to AB-test compaction strategies at fleet scale.

## Pipeline Overview

The compaction pipeline runs on every iteration of the main ReAct loop in `query.ts`. Layers execute in strict order — earlier layers are cheaper and less destructive, so they fire first and may prevent later layers from triggering at all.

```
 User message arrives
        │
        ▼
┌──────────────────────┐
│ 0. Tool Result Budget │  Per-message size enforcement (pre-compaction)
│    applyToolResultBudget() persists oversized results to disk,
│    replaces inline content with file references
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 1. History Snip       │  Feature: HISTORY_SNIP
│    snipCompactIfNeeded() removes stale prefix messages
│    Reports tokensFreed downstream to adjust autocompact threshold
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 2. Microcompact       │  Two sub-paths:
│    a) Time-based MC   │    Gap > 60min → cold cache → clear old tool results
│    b) Cached MC       │    Feature: CACHED_MICROCOMPACT
│       cache_edits API to delete tool results without
│       invalidating prompt cache prefix
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 3. Context Collapse   │  Feature: CONTEXT_COLLAPSE
│    Staged collapse projections that persist across turns.
│    Read-time view projection — no messages yielded.
│    Suppresses autocompact when enabled.
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 4. Auto Compact       │  Token threshold trigger
│    a) Session Memory   │    Uses pre-extracted session memory (no LLM call)
│    b) Full Compact     │    LLM-based summarisation via forked agent
│    Circuit breaker: max 3 consecutive failures
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 5. API-Level Context  │  Server-side strategies sent with API request
│    Management         │    clear_tool_uses_20250919 (tool result clearing)
│                       │    clear_thinking_20251015 (thinking block clearing)
└──────────┬───────────┘
           │
           ▼
     API call fires
           │
       on 413 error
           │
           ▼
┌──────────────────────┐
│ 6. Reactive Compact   │  Feature: REACTIVE_COMPACT
│    Post-failure recovery from prompt-too-long (413) errors.
│    First tries context collapse drain, then full reactive compact.
│    Single-shot — no retry spiral.
└──────────────────────┘
```

### Pipeline Orchestration (query.ts)

The pipeline is orchestrated in `query.ts:378-467`:

```typescript
// Layer 0: Tool Result Budget (runs first)
messagesForQuery = await applyToolResultBudget(
  messagesForQuery,
  toolUseContext.contentReplacementState,
  persistReplacements ? records => void recordContentReplacement(...) : undefined,
  new Set(toolUseContext.options.tools
    .filter(t => !Number.isFinite(t.maxResultSizeChars))
    .map(t => t.name)),
)

// Layer 1: Snip
let snipTokensFreed = 0
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
}

// Layer 2: Microcompact
const microcompactResult = await deps.microcompact(
  messagesForQuery, toolUseContext, querySource,
)
messagesForQuery = microcompactResult.messages

// Layer 3: Context Collapse
if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    messagesForQuery, toolUseContext, querySource,
  )
  messagesForQuery = collapseResult.messages
}

// Layer 4: Auto Compact
const { compactionResult, consecutiveFailures } = await deps.autocompact(
  messagesForQuery, toolUseContext, {...}, querySource, tracking, snipTokensFreed,
)
```

## Layer 0: Tool Result Budget

**File:** `utils/toolResultStorage.ts`  
**Purpose:** Pre-compaction per-message size enforcement — prevents individual tool results from consuming disproportionate context.

This layer runs before any compaction. It's not a context-reduction strategy per se — it prevents oversized tool results from entering the context in the first place.

### Mechanism

When a tool result exceeds its persistence threshold, the full content is written to disk (`<session-dir>/tool-results/<id>.txt`) and replaced inline with a file reference + preview:

```typescript
export async function maybePersistLargeToolResult(
  toolResultBlock: ToolResultBlockParam,
  toolName: string,
  persistenceThreshold?: number,
): Promise<ToolResultBlockParam>
```

The threshold is resolved per-tool:
1. GrowthBook override map (`tengu_satin_quoll`) — per-tool-name threshold overrides
2. Declared `maxResultSizeChars` on the tool, clamped by `DEFAULT_MAX_RESULT_SIZE_CHARS` (50K)
3. Tools with `maxResultSizeChars = Infinity` are exempt (they self-bound via `maxTokens`)

### Per-Message Aggregate Budget

Beyond per-result persistence, there's an aggregate budget enforced across all tool results within a single user message:

```typescript
export type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}
```

`enforceToolResultBudget()` walks each user message's tool_result blocks. When the aggregate content exceeds `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` (overridable via `tengu_hawthorn_window`), oldest-first results are replaced with cleared markers. The replacement decisions are persisted to the transcript so they survive session resume and produce byte-identical wire content (prompt cache stability).

### Empty Result Handling

Empty tool results cause a subtle model failure on some architectures — the server renderer's turn-boundary pattern-matching triggers, causing the model to emit a stop sequence with zero output. All empty results are replaced with `(toolName completed with no output)`.

## Layer 1: History Snip

**Feature flag:** `HISTORY_SNIP`  
**File:** `services/compact/snipCompact.ts` (feature-gated `require()`)

Snip is a lightweight prefix-removal strategy. It removes stale messages from the beginning of the conversation without any LLM summarisation. The key detail is that `snipTokensFreed` is threaded downstream to autocompact's threshold check — since `tokenCountWithEstimation` reads the token count from the last API response's usage field (which reflects the pre-snip context), autocompact can't "see" what snip removed. The freed count is subtracted explicitly:

```typescript
const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
```

Snip and microcompact are not mutually exclusive — both may run in the same turn.

## Layer 2: Microcompact

**File:** `services/compact/microCompact.ts`  
**Purpose:** Clear old tool results from context, either by mutating message content (time-based) or by instructing the server to delete cached content (cached MC).

### Compactable Tools

Only specific tools' results are eligible for microcompaction:

```typescript
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,    // Bash, PowerShell
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])
```

### Entry Point

`microcompactMessages()` tries two paths in order:

```typescript
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  // Path A: Time-based trigger (short-circuits if fires)
  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) return timeBasedResult

  // Path B: Cached MC (cache-editing API)
  if (feature('CACHED_MICROCOMPACT')) {
    // ... check enabled, model supported, main thread only
    return await cachedMicrocompactPath(messages, querySource)
  }

  // No compaction — autocompact handles pressure instead
  return { messages }
}
```

### Path A: Time-Based Microcompact

**Config:** `services/compact/timeBasedMCConfig.ts` (GrowthBook flag `tengu_slate_heron`)

```typescript
const TIME_BASED_MC_CONFIG_DEFAULTS: TimeBasedMCConfig = {
  enabled: false,
  gapThresholdMinutes: 60,
  keepRecent: 5,
}
```

**Trigger:** When the gap between now and the last assistant message exceeds the threshold (default 60 minutes), the server's prompt cache has expired. Since the full prefix will be rewritten anyway, clearing old tool results shrinks the rewrite cost.

**Mechanism:**
1. `evaluateTimeBasedTrigger()` measures `(Date.now() - lastAssistant.timestamp) / 60_000`
2. Requires explicit main-thread `querySource` (analysis-only callers like `/context` don't trigger)
3. `collectCompactableToolIds()` gathers all eligible tool_use IDs in encounter order
4. Keeps the last N (default 5, minimum 1) and clears the rest by replacing content with `'[Old tool result content cleared]'`

**Key constraint:** `keepRecent` is floored at 1 because `slice(-0)` returns the full array (keeping everything), and clearing ALL results leaves the model with zero working context.

```typescript
const keepRecent = Math.max(1, config.keepRecent)
const keepSet = new Set(compactableIds.slice(-keepRecent))
```

**Interaction with Cached MC:** When time-based MC fires, cached MC is skipped entirely. Cache-editing assumes a warm cache; time-based MC establishes the cache is cold.

### Path B: Cached Microcompact

**Feature flag:** `CACHED_MICROCOMPACT`  
**Additional module:** `services/compact/cachedMicrocompact.ts` (lazy-loaded)

This is the sophisticated path. Instead of mutating local message content, it uses the API's `cache_edits` mechanism to instruct the server to delete specific tool results from the cached prefix — without invalidating the rest of the cache.

**Architecture:**

```
Local messages (unchanged)
    │
    ▼
cachedMicrocompactPath() tracks tool results via CachedMCState
    │
    ├─ Registers tool_result blocks grouped by user message
    ├─ Decides which to delete (count-based threshold from GrowthBook)
    └─ Creates cache_edits block → stored as pendingCacheEdits
        │
        ▼
API call includes cache_edits alongside messages
    │
    ▼
Server deletes specified tool results from cached prefix
Response includes cache_deleted_input_tokens (cumulative)
    │
    ▼
pinCacheEdits() saves the edit at its user message position
    → Re-sent on subsequent calls for cache hits
```

**State management:**

```typescript
let cachedMCState: CachedMCState | null = null
let pendingCacheEdits: CacheEditsBlock | null = null
```

- `CachedMCState` tracks: registered tool IDs, tool message groups, deletion refs, pinned edits
- `consumePendingCacheEdits()`: One-shot getter — returns and clears pending edits for the API call
- `pinCacheEdits()`: After API response, pins the edit at its user message index so it's re-sent
- `getPinnedCacheEdits()`: Returns all previously-pinned edits for re-inclusion in subsequent calls

**Main thread only:** Sub-agents (session_memory, prompt_suggestion) are excluded because they share module-level state with the main thread. A forked agent registering its tool_results in global `cachedMCState` would cause the main thread to try deleting tools that don't exist in its own conversation.

**Boundary message deferral:** Unlike time-based MC which yields a boundary immediately, cached MC defers its boundary message until after the API response — so it can report the actual `cache_deleted_input_tokens` from the server rather than a client-side estimate.

## Layer 3: Context Collapse

**Feature flag:** `CONTEXT_COLLAPSE`  
**Module:** `services/contextCollapse/index.ts` (feature-gated `require()`)

Context collapse is a staged projection system that replaces groups of messages with summaries while preserving the illusion of a contiguous conversation.

### Key design properties

1. **Read-time projection:** Collapse doesn't modify the REPL message array. It creates a virtual view over it. `projectView()` replays the commit log on every entry to the query loop.

2. **Persistence across turns:** The collapsed view flows forward via `state.messages` at the continue site (`query.ts:1192`). The next `projectView()` no-ops because archived messages are already gone from its input.

3. **Suppresses autocompact:** When context collapse is enabled, proactive autocompact is suppressed. Collapse owns the headroom problem via its own threshold system (90% commit, 95% blocking). Autocompact's effective-13K trigger (~93%) sits between these, so it would race collapse and usually win, destroying the granular context that collapse was about to preserve.

```typescript
// From shouldAutoCompact():
if (feature('CONTEXT_COLLAPSE')) {
  const { isContextCollapseEnabled } =
    require('../contextCollapse/index.js')
  if (isContextCollapseEnabled()) {
    return false  // suppress proactive autocompact
  }
}
```

4. **413 recovery integration:** Context collapse provides `recoverFromOverflow()` for reactive recovery. When a prompt-too-long error occurs, the recovery sequence is: drain all staged collapses first (cheap, preserves granular context), then fall through to reactive compact (full summary) only if draining wasn't sufficient.

## Layer 4: Auto Compact

**File:** `services/compact/autoCompact.ts`  
**Purpose:** Full conversation summarisation when the context window approaches capacity.

### Threshold Calculation

```typescript
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model), 20_000,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())
  // Optional override via CLAUDE_CODE_AUTO_COMPACT_WINDOW
  return contextWindow - reservedTokensForSummary
}

export function getAutoCompactThreshold(model: string): number {
  return getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
}
```

For a 200K context window model with 20K max output:
- Effective window = 200K - 20K = 180K
- Autocompact threshold = 180K - 13K = 167K tokens
- Warning threshold = 167K - 20K = 147K tokens
- Blocking limit = 180K - 3K = 177K tokens

### Trigger Guards

`shouldAutoCompact()` has multiple guard clauses:

| Guard | Reason |
|-------|--------|
| `querySource === 'session_memory' \|\| 'compact'` | Prevent deadlocked forked agents |
| `querySource === 'marble_origami'` | Context-collapse agent — resetting would destroy main thread's collapse log |
| `!isAutoCompactEnabled()` | User/env disabled |
| `tengu_cobalt_raccoon` flag (REACTIVE_COMPACT) | Reactive-only mode suppresses proactive autocompact |
| `isContextCollapseEnabled()` | Collapse owns headroom when active |

### Two-Phase Compaction

`autoCompactIfNeeded()` tries two strategies in order:

**Phase 1: Session Memory Compaction** (experimental, no LLM call)

```typescript
const sessionMemoryResult = await trySessionMemoryCompaction(
  messages, toolUseContext.agentId, recompactionInfo.autoCompactThreshold,
)
```

**Phase 2: Full LLM Compaction** (fallback)

```typescript
const compactionResult = await compactConversation(
  messages, toolUseContext, cacheSafeParams,
  true,      // suppressFollowUpQuestions
  undefined, // no custom instructions for autocompact
  true,      // isAutoCompact
  recompactionInfo,
)
```

### Circuit Breaker

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

After 3 consecutive failures, autocompact stops attempting for the rest of the session. This was added after observing 1,279 sessions with 50+ consecutive failures (up to 3,272) in a single session, wasting ~250K API calls/day globally.

The failure count is threaded through `AutoCompactTrackingState` and reset to 0 on success.

## Session Memory Compaction (Layer 4a)

**File:** `services/compact/sessionMemoryCompact.ts`  
**Purpose:** Replace full LLM summarisation with pre-extracted session memory, avoiding the cost and latency of a compaction API call.

### Prerequisites

Requires two GrowthBook flags both enabled:
- `tengu_session_memory` — session memory extraction active
- `tengu_sm_compact` — SM-based compaction enabled

### Configuration

```typescript
export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
}
```

Remote configuration via `tengu_sm_compact_config` (fetched once per session via `getDynamicConfig_BLOCKS_ON_INIT`).

### Algorithm

1. **Wait for extraction:** `waitForSessionMemoryExtraction()` ensures any in-progress background extraction completes
2. **Validate content:** Checks session memory exists and isn't just the empty template
3. **Find boundary:** Uses `lastSummarizedMessageId` to identify which messages have already been covered by session memory
4. **Calculate keep index:** `calculateMessagesToKeepIndex()` expands backwards from the boundary:
   - At least `minTokens` (10K) tokens of recent messages
   - At least `minTextBlockMessages` (5) messages containing text
   - Hard cap at `maxTokens` (40K) — stops expanding if hit
   - Floor: never goes past the last compact boundary marker
5. **Preserve API invariants:** `adjustIndexToPreserveAPIInvariants()` ensures:
   - No tool_use/tool_result pairs are split across the keep boundary
   - No thinking blocks that share a `message.id` with kept messages are orphaned (streaming yields separate messages per content block)
6. **Build result:** Session memory text becomes the summary, kept messages follow verbatim

### Resumed Session Handling

When `lastSummarizedMessageId` is not set but session memory has content (resumed session), the algorithm starts with `lastSummarizedIndex = messages.length - 1` (no messages initially kept), then expands backward to meet the minimums.

## Full LLM Compaction (Layer 4b)

**File:** `services/compact/compact.ts`  
**Purpose:** Generate a structured summary of the conversation via a forked LLM call.

### Prompt Design

The compaction prompt (`services/compact/prompt.ts`) uses a dual-block architecture:

```
┌─────────────────────────────────┐
│ NO_TOOLS_PREAMBLE               │  "CRITICAL: Respond with TEXT ONLY"
├─────────────────────────────────┤
│ BASE_COMPACT_PROMPT             │  9-section summary template
│  1. Primary Request and Intent  │
│  2. Key Technical Concepts      │
│  3. Files and Code Sections     │
│  4. Errors and Fixes            │
│  5. Problem Solving             │
│  6. All User Messages           │
│  7. Pending Tasks               │
│  8. Current Work                │
│  9. Optional Next Step          │
├─────────────────────────────────┤
│ Custom Instructions (optional)  │  User-provided + hook-provided
├─────────────────────────────────┤
│ NO_TOOLS_TRAILER                │  "REMINDER: Do NOT call any tools"
└─────────────────────────────────┘
```

**Analysis scratchpad:** The prompt instructs the model to emit an `<analysis>` block before the `<summary>`. This acts as a chain-of-thought drafting space. `formatCompactSummary()` strips the analysis block from the final summary — it improves quality but has no informational value once written.

```typescript
export function formatCompactSummary(summary: string): string {
  let formattedSummary = summary
  formattedSummary = formattedSummary.replace(
    /<analysis>[\s\S]*?<\/analysis>/, '',
  )
  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${summaryMatch[1]?.trim()}`,
    )
  }
  return formattedSummary.trim()
}
```

**No-tools enforcement:** The model sees the parent's full tool set (required for cache-key match on the forked agent path), but on Sonnet 4.6+ adaptive-thinking models it sometimes attempts a tool call despite instructions. With `maxTurns: 1`, a denied tool call means no text output. The aggressive preamble + trailer pattern prevents this (reduced from 2.79% failure on 4.6 to near-zero).

### Forked Agent Architecture

Compaction runs via `runForkedAgent()` which shares the parent conversation's prompt cache:

```typescript
const promptCacheSharingEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
  'tengu_compact_cache_prefix', true,
)
```

The forked agent sees the full conversation plus the compaction prompt as the final user message, generates a streaming summary, and returns. Cache sharing is on by default (3P default: true). An experiment confirmed the non-sharing path is 98% cache miss.

### Prompt-Too-Long Retry Loop

When the compaction request itself exceeds the context window (`PROMPT_TOO_LONG_ERROR_MESSAGE`):

```typescript
const MAX_PTL_RETRIES = 3

export function truncateHeadForPTLRetry(
  messages: Message[],
  ptlResponse: AssistantMessage,
): Message[] | null
```

This drops the oldest API-round groups until the token gap is covered:
- If the error includes a parseable token gap, drops exactly enough groups
- Otherwise, drops 20% of groups as a fallback
- Always keeps at least one group to summarise
- Prepends a synthetic user marker if the result starts with an assistant message (API requires user-first)

### Pre-Processing

Before sending messages to the summariser:

1. **`stripImagesFromMessages()`** — Replaces image/document blocks with `[image]`/`[document]` text markers. Images aren't needed for summarisation and can themselves push the compaction call over the context limit.

2. **`stripReinjectedAttachments()`** — Removes skill_discovery/skill_listing attachments that will be re-injected post-compact anyway.

### Post-Compact Recovery

After a successful compaction, the system rebuilds the context with attachments:

```typescript
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
}
```

**Attachment types re-injected:**

| Attachment | Budget | Purpose |
|-----------|--------|---------|
| File state | Max 5 files, 5K tok each, 50K total | Recently-read files the model was working with |
| Plan state | — | Current plan context if active |
| Plan mode instructions | — | If user is in plan mode |
| Skill content | 5K tok/skill, 25K total | Invoked skill instructions |
| Deferred tools delta | — | Already-loaded tool schemas |
| Agent listing delta | — | Available sub-agent types |
| MCP instructions delta | — | MCP server instructions |
| Session start hooks | — | CLAUDE.md and other session context |

```typescript
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000
```

### Partial Compaction

`partialCompactConversation()` supports two directions:

- **`'from'` direction:** Summarises messages after a pivot index, keeps earlier ones intact. Preserves prompt cache for the kept prefix.
- **`'up_to'` direction:** Summarises messages before the pivot, keeps later ones. Cache is invalidated since the summary precedes kept messages. Uses a different prompt template (`PARTIAL_COMPACT_UP_TO_PROMPT`) that adds a "Context for Continuing Work" section.

## Layer 5: API-Level Context Management

**File:** `services/compact/apiMicrocompact.ts`  
**Purpose:** Server-side context management strategies sent as part of the API request.

These strategies operate at the API level — the server applies them before tokenising the prompt.

### Strategy Types

```typescript
export type ContextEditStrategy =
  | {
      type: 'clear_tool_uses_20250919'
      trigger?: { type: 'input_tokens'; value: number }
      keep?: { type: 'tool_uses'; value: number }
      clear_tool_inputs?: boolean | string[]
      exclude_tools?: string[]
      clear_at_least?: { type: 'input_tokens'; value: number }
    }
  | {
      type: 'clear_thinking_20251015'
      keep: { type: 'thinking_turns'; value: number } | 'all'
    }
```

### Thinking Block Clearing

Universal (not ant-only). Preserves thinking blocks unless:
- Redact-thinking is active (redacted blocks have no model-visible content)
- `clearAllThinking` is set (>1h idle = cache miss) — keeps only the last thinking turn (API requires `value >= 1`)

### Tool Clearing (Ant-Only)

Gated behind `USER_TYPE === 'ant'` and env flags `USE_API_CLEAR_TOOL_RESULTS` / `USE_API_CLEAR_TOOL_USES`.

```typescript
const DEFAULT_MAX_INPUT_TOKENS = 180_000  // Trigger threshold
const DEFAULT_TARGET_INPUT_TOKENS = 40_000  // Keep last 40K tokens
```

Two sub-strategies can be enabled independently:
- **Clear tool results:** `clear_tool_inputs` set to `TOOLS_CLEARABLE_RESULTS` (Bash, Glob, Grep, FileRead, WebFetch, WebSearch)
- **Clear tool uses:** `exclude_tools` set to `TOOLS_CLEARABLE_USES` (FileEdit, FileWrite, NotebookEdit) — clears everything except these

Both trigger at 180K input tokens and clear at least `180K - 40K = 140K` tokens.

## Layer 6: Reactive Compact

**Feature flag:** `REACTIVE_COMPACT`  
**Module:** `services/compact/reactiveCompact.ts` (feature-gated `require()`)  
**Trigger:** Post-failure recovery from API 413 (prompt-too-long) or media-size errors.

Unlike layers 0-5 which are proactive (run before the API call), reactive compact runs after a failed API call. The error is withheld from the message stream and handled internally.

### Recovery Sequence (query.ts:1065-1183)

```
413 error withheld from stream
         │
         ▼
    ┌────────────────────────┐
    │ Try context collapse   │  (if CONTEXT_COLLAPSE enabled)
    │ drain first            │  Cheap, preserves granular context
    └────────┬───────────────┘
             │ (if drain committed > 0)
             ├─── retry with drained messages ──→ continue loop
             │
             │ (if drain didn't help or wasn't available)
             ▼
    ┌────────────────────────┐
    │ tryReactiveCompact()   │  Full compaction via forked agent
    └────────┬───────────────┘
             │ success
             ├─── yield post-compact messages ──→ continue loop
             │
             │ failure
             ▼
    Surface error to user + execute stop failure hooks
```

**Single-shot guard:** `hasAttemptedReactiveCompact` prevents retry spirals. If reactive compact runs and the retry still 413s, the error surfaces.

**Media error recovery:** Image/PDF/many-image size errors are also handled via reactive compact's strip-retry path. Unlike prompt-too-long, media errors skip the collapse drain (collapse doesn't strip images). If the oversized media is in the preserved tail, the post-compact turn will media-error again; the single-shot guard prevents a spiral.

## Post-Compact Cleanup

**File:** `services/compact/postCompactCleanup.ts`  
**Called after:** All compaction paths (auto, manual, reactive, session memory)

Resets state that's invalidated by compaction:

```typescript
export function runPostCompactCleanup(querySource?: QuerySource): void {
  resetMicrocompactState()           // Clear cached MC state + pending edits
  resetContextCollapse()             // Clear collapse commit log (main thread only)
  getUserContext.cache.clear()       // Clear memoised user context
  resetGetMemoryFilesCache('compact') // Re-arm CLAUDE.md loading hook
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  clearBetaTracingState()
  sweepFileContentCache()            // Commit attribution cache (if enabled)
  clearSessionMessagesCache()
}
```

**Main-thread safety:** Sub-agents run in the same process and share module-level state. The cleanup distinguishes main-thread compacts from sub-agent compacts using `querySource`:

```typescript
const isMainThreadCompact =
  querySource === undefined ||
  querySource.startsWith('repl_main_thread') ||
  querySource === 'sdk'
```

Context collapse and memory file cache are only reset for main-thread compacts — resetting them for a sub-agent would corrupt the main thread's state.

## Message Grouping

**File:** `services/compact/grouping.ts`  
**Used by:** `truncateHeadForPTLRetry()`, reactive compact

Messages are grouped by API round boundaries — each group is one API round-trip:

```typescript
export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  // Boundary fires when a NEW assistant response begins
  // (different message.id from prior assistant)
  // Streaming chunks from the same API response share an id,
  // so boundaries only fire at genuinely new rounds
}
```

This replaced earlier human-turn grouping (boundaries only at real user prompts) with finer-grained API-round grouping, allowing reactive compact to work on single-prompt agentic sessions (SDK/CCR/eval) where the entire workload is one human turn.

## Feature Flag Architecture

Every compaction layer is independently gated:

| Layer | Feature Flag | Build-Time DCE |
|-------|-------------|----------------|
| Snip | `HISTORY_SNIP` | Yes — `feature()` + `require()` |
| Time-based MC | GrowthBook `tengu_slate_heron` | No (runtime config) |
| Cached MC | `CACHED_MICROCOMPACT` | Yes |
| Context Collapse | `CONTEXT_COLLAPSE` | Yes |
| Reactive Compact | `REACTIVE_COMPACT` | Yes |
| Session Memory | GrowthBook `tengu_session_memory` + `tengu_sm_compact` | No |
| API Context Mgmt | Env flags + `USER_TYPE` | No |

Build-time flags use Bun's `feature()` from `bun:bundle` for dead code elimination — the entire module and its `require()` call are stripped from external builds when the flag is off.

## Layer Interactions

The layers are designed to compose, with explicit interaction points:

1. **Snip → Autocompact:** `snipTokensFreed` is passed to autocompact to adjust its threshold calculation (tokenCountWithEstimation can't see what snip removed).

2. **Time-based MC → Cached MC:** Time-based MC short-circuits cached MC. If the cache is cold (gap > threshold), cache-editing is pointless.

3. **Context Collapse → Autocompact:** When collapse is enabled, proactive autocompact is suppressed. Collapse's 90% commit threshold sits below autocompact's ~93%, preventing a race.

4. **Context Collapse → Reactive Compact:** On 413, collapse drain runs first. Only if draining fails does reactive compact fire.

5. **All layers → Post-Compact Cleanup:** Every compaction path calls `runPostCompactCleanup()` to reset microcompact state, collapse logs, and various caches.

6. **Tool Result Budget → Microcompact:** Budget runs first in the pipeline, persisting oversized results to disk. Microcompact then operates on the already-budgeted messages.

## Token Estimation

**Function:** `estimateMessageTokens()` in `microCompact.ts`

Used by session memory compaction and other layers for pre-API-call token estimation:

```typescript
export function estimateMessageTokens(messages: Message[]): number {
  // Walks all content blocks:
  // - text → roughTokenCountEstimation
  // - tool_result → recursive content walk
  // - image/document → flat 2000 tokens
  // - thinking → text content only (not signature)
  // - tool_use → name + input
  // Pads by 4/3 for conservatism
  return Math.ceil(totalTokens * (4 / 3))
}
```

The 4/3 padding ensures the estimate errs on the side of triggering compaction too early rather than too late.

## Compaction Summary Message Format

After compaction, the summary is injected as a user message with metadata:

```typescript
function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string
```

The message includes:
- "This session is being continued from a previous conversation..."
- The formatted summary (analysis stripped, summary tags replaced with headers)
- Link to full transcript file for pre-compaction detail retrieval
- Note about recent messages being preserved (for SM-compact)
- Continuation instructions (for auto-compact): "Resume directly — do not acknowledge the summary"
- Autonomous mode detection: if proactive/kairos mode is active, explicit instruction to continue the work loop

## Telemetry

Every compaction layer emits analytics events:

| Event | Layer |
|-------|-------|
| `tengu_auto_compact_succeeded` | Autocompact |
| `tengu_compact` | Full LLM compaction |
| `tengu_compact_failed` | Compaction failure |
| `tengu_compact_ptl_retry` | PTL retry loop |
| `tengu_cached_microcompact` | Cached MC |
| `tengu_time_based_microcompact` | Time-based MC |
| `tengu_sm_compact_*` | Session memory compaction |
| `tengu_tool_empty_result` | Empty result injection |

The `tengu_compact` event includes a `willRetriggerNextTurn` field — a diagnostic that compares the post-compact token count against the autocompact threshold. This helps identify compactions that produce summaries too large for the threshold, causing immediate re-compaction on the next turn.

## Design Philosophy

The system reflects several deliberate design choices:

1. **Progressive degradation:** Each layer is more expensive and more destructive than the last. The pipeline is ordered so cheap operations (budget enforcement, snip) prevent expensive ones (LLM summarisation) from firing unnecessarily.

2. **Cache awareness:** Multiple layers are designed around the server's prompt cache — time-based MC only fires when the cache is cold, cached MC uses cache_edits to preserve the warm prefix, the forked agent shares the parent's cache.

3. **Fleet-scale experimentation:** Every layer is independently gated via feature flags or GrowthBook configs, allowing Anthropic to AB-test strategies across the user base. The GrowthBook flag names follow a `tengu_<adjective>_<animal>` pattern to avoid accidental collisions.

4. **Defensive engineering:** Circuit breakers (max 3 failures), single-shot guards (reactive compact), empty-result handling, PTL retry loops with truncation — the system is designed to degrade gracefully rather than fail catastrophically. The 4/3 token padding, keepRecent floor at 1, and tool_use/tool_result pair preservation all guard against edge cases that would corrupt the conversation state.

5. **Process isolation awareness:** Sub-agents share module-level state with the main thread. Post-compact cleanup, cached MC, and context collapse all explicitly distinguish main-thread operations from sub-agent operations to prevent cross-contamination.
