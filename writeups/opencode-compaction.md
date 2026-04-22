# OpenCode Compaction System — Deep Dive

> How OpenCode manages context window limits through a multi-phase system of tool output pruning, tail turn selection, AI-generated summarisation, and transparent message filtering.

## The Problem

A coding agent conversation can easily exceed the LLM's context window. Tool outputs are especially expensive — a single `read` of a large file or `bash` command with verbose output can consume thousands of tokens. OpenCode needs to keep conversations going indefinitely without losing critical context.

## System Overview

OpenCode's compaction is a **4-stage pipeline** triggered automatically when token consumption approaches the model's context limit:

```
                    ┌─────────────────────┐
                    │  Overflow Detection  │
                    │ (processor + loop)   │
                    └──────────┬──────────┘
                               ▼
                    ┌─────────────────────┐
              ┌────►│  1. Tool Pruning     │  Marks old tool outputs as compacted
              │     │     (prune)          │  Saves tokens without losing structure
              │     └──────────┬──────────┘
              │                ▼
              │     ┌─────────────────────┐
              │     │  2. Tail Selection   │  Picks recent turns to keep verbatim
   Runs in    │     │     (select)         │  Budget-constrained by token estimate
   sequence   │     └──────────┬──────────┘
              │                ▼
              │     ┌─────────────────────┐
              │     │  3. Summary Gen      │  LLM summarises the "head" messages
              │     │     (process)        │  using the hidden compaction agent
              │     └──────────┬──────────┘
              │                ▼
              │     ┌─────────────────────┐
              └────►│  4. Message Filter   │  filterCompacted() hides old messages
                    │     (read path)      │  from the model on next loop iteration
                    └─────────────────────┘
```

## Stage 0: Overflow Detection

Two detection paths feed into compaction:

### Path A: Post-stream token check (proactive)

After each LLM stream completes, the processor checks whether total token usage has crossed the threshold.

```typescript
// processor.ts:397-402
if (
  !ctx.assistantMessage.summary &&
  isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
) {
  ctx.needsCompaction = true
}
```

When `needsCompaction` is set, the stream is drained via `Stream.takeUntil(() => ctx.needsCompaction)` and the processor returns `"compact"`.

### Path B: ContextOverflowError (reactive)

If the LLM provider itself returns a context overflow error, it's caught in the error handler:

```typescript
// processor.ts:526-529
if (MessageV2.ContextOverflowError.isInstance(error)) {
  ctx.needsCompaction = true
  yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
  return
}
```

### The `usable()` budget calculation

The overflow threshold is computed by `overflow.ts`:

```typescript
// overflow.ts:8-16
export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))

  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model))
}
```

Where `COMPACTION_BUFFER = 20_000`. The logic:
- If the model specifies a separate `limit.input`, use that minus the reserved buffer
- Otherwise, use `context - maxOutputTokens` (the input portion of the window)
- The reserved buffer defaults to `min(20K, maxOutputTokens)` — leaving room for the compaction summary itself

Total token count is computed as:
```typescript
const count = input.tokens.total ||
  input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
```

Note: cache read/write tokens are included because they still consume context window space even when served from cache.

### Compaction disabled

If `cfg.compaction?.auto === false` or `model.limit.context === 0`, overflow detection returns `false` and the system never compacts.

## Stage 1: Tool Output Pruning

**File**: `compaction.ts:173-219`

Pruning is the cheapest compaction operation. It doesn't involve an LLM call — it simply marks old tool outputs as compacted, causing them to be replaced with `"[Old tool result content cleared]"` when building model messages.

### Algorithm

Walk backward through messages, skipping the 2 most recent user turns:

```typescript
// compaction.ts:188-207
loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
  const msg = msgs[msgIndex]
  if (msg.info.role === "user") turns++
  if (turns < 2) continue                                    // protect recent turns
  if (msg.info.role === "assistant" && msg.info.summary) break loop  // stop at prior summary
  for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
    const part = msg.parts[partIndex]
    if (part.type === "tool")
      if (part.state.status === "completed") {
        if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue  // never prune "skill"
        if (part.state.time.compacted) break loop                 // already pruned before
        const estimate = Token.estimate(part.state.output)
        total += estimate
        if (total > PRUNE_PROTECT) {                              // first 40K tokens safe
          pruned += estimate
          toPrune.push(part)
        }
      }
  }
}
```

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `PRUNE_PROTECT` | 40,000 tokens | The most recent 40K tokens of tool outputs are never pruned |
| `PRUNE_MINIMUM` | 20,000 tokens | Pruning only fires if it would reclaim at least 20K tokens |
| `PRUNE_PROTECTED_TOOLS` | `["skill"]` | Skill tool outputs are never pruned (they contain instructions) |

### What pruning does to messages

Pruning sets `part.state.time.compacted = Date.now()` on tool parts. When `toModelMessagesEffect` later builds the LLM input, it checks this timestamp:

```typescript
// message-v2.ts:842-843
const outputText = part.state.time.compacted
  ? "[Old tool result content cleared]"
  : part.state.output
const attachments = part.state.time.compacted || options?.stripMedia
  ? []
  : (part.state.attachments ?? [])
```

The tool call structure (tool name, input args, call ID) is preserved — only the output text and attachments are cleared. This means the LLM still sees that a tool was called with specific arguments, it just can't see the result.

### When pruning runs

Pruning runs at the **end** of the main loop, after the final assistant message is determined, as a fire-and-forget fork:

```typescript
// prompt.ts:1530
yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
```

It also runs as part of the full compaction flow (before summary generation).

### Token estimation

Token counts use a simple heuristic rather than a real tokenizer:

```typescript
// util/token.ts
const CHARS_PER_TOKEN = 4
export function estimate(input: string) {
  return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
}
```

4 characters per token is a rough average for English text. This avoids the cost of loading a tokenizer but can be inaccurate for code, JSON, or non-Latin text.

## Stage 2: Tail Turn Selection

**File**: `compaction.ts:130-169`

When full compaction triggers, the system decides which recent turns to keep verbatim (the "tail") versus which to summarise (the "head").

### Turn detection

A "turn" starts at each user message and extends through the following assistant response:

```typescript
// compaction.ts:52-68
function turns(messages: MessageV2.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue  // skip compaction markers
    result.push({ start: i, end: messages.length, id: msg.info.id })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start  // each turn ends where the next begins
  }
  return result
}
```

### Budget calculation

The token budget for preserved tail turns:

```typescript
// compaction.ts:45-49
function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS,
      Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}
```

Default: 25% of usable context, clamped to [2K, 8K] tokens. For a 200K context model, that's 8K tokens for the tail.

### Selection algorithm

Take the last N turns (default `tail_turns = 2`) and work backward:

```typescript
// compaction.ts:140-168
const recent = all.slice(-limit)  // last N turns

// Estimate token size of each turn
const sizes = yield* Effect.forEach(recent, (turn) =>
  estimate({ messages: input.messages.slice(turn.start, turn.end), model }),
  { concurrency: 1 },
)

// If the most recent turn alone exceeds budget, give up on tail preservation
if (sizes.at(-1)! > budget) {
  return { head: input.messages, tail_start_id: undefined }
}

// Greedily include turns from newest to oldest within budget
let total = 0
let keep: Turn | undefined
for (let i = recent.length - 1; i >= 0; i--) {
  const size = sizes[i]
  if (total + size > budget) break
  total += size
  keep = recent[i]
}

if (!keep || keep.start === 0)
  return { head: input.messages, tail_start_id: undefined }
return {
  head: input.messages.slice(0, keep.start),  // everything before the kept tail
  tail_start_id: keep.id,                      // bookmark for later filtering
}
```

The key insight: **the head gets summarised, the tail stays verbatim**. The `tail_start_id` is stored on the CompactionPart so `filterCompacted()` knows where to resume including raw messages.

### Edge cases

- If `tail_turns = 0`, the entire conversation is summarised (no tail preserved)
- If the most recent turn exceeds the budget, no tail is preserved (the whole thing gets summarised)
- If `keep.start === 0` (the tail is the entire conversation), no compaction happens

## Stage 3: Summary Generation

**File**: `compaction.ts:221-457`

This is the core of compaction: the system calls the LLM to produce a summary of the conversation's "head" (everything before the preserved tail).

### The compaction agent

A hidden agent named `"compaction"` with its own system prompt:

```
You are a helpful AI assistant tasked with summarizing conversations.

When asked to summarize, provide a detailed but concise summary of the older
conversation history. The most recent turns may be preserved verbatim outside
your summary, so focus on information that would still be needed to continue
the work with that recent context available.

Focus on information that would be helpful for continuing the conversation:
- What was done
- What is currently being worked on
- Which files are being modified
- What needs to be done next
- Key user requests, constraints, or preferences that should persist
- Important technical decisions and why they were made

Do not respond to any questions in the conversation, only output the summary.
Respond in the same language the user used in the conversation.
```

### The summary template

The user message sent to the compaction agent includes a structured template:

```markdown
When constructing the summary, try to stick to this template:
---
## Goal
[What goal(s) is the user trying to accomplish?]

## Instructions
- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries
[What notable things were learned during this conversation that would be useful
for the next agent to know when continuing the work]

## Accomplished
[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories
[Construct a structured list of relevant files that have been read, edited, or
created that pertain to the task at hand.]
---
```

### Message preparation

Before sending to the LLM:
1. The head messages are deep-cloned
2. Plugin hook `experimental.chat.messages.transform` fires (plugins can modify)
3. Messages are converted to model format with `stripMedia: true` (images/PDFs replaced with `[Attached image/png: file]`)
4. The template is appended as a final user message

### The compaction part

When compaction triggers, a marker is inserted into the conversation:

```typescript
// compaction.ts:474-481
yield* session.updatePart({
  id: PartID.ascending(),
  messageID: msg.id,
  sessionID: msg.sessionID,
  type: "compaction",
  auto: input.auto,
  overflow: input.overflow,
})
```

This `CompactionPart` is stored as a part on a user message and converted to `"What did we do so far?"` when building model messages:

```typescript
// message-v2.ts:795-800
if (part.type === "compaction") {
  userMessage.parts.push({
    type: "text",
    text: "What did we do so far?",
  })
}
```

### The summary message

The LLM's response is stored as an assistant message with `summary: true`:

```typescript
const msg: MessageV2.Assistant = {
  // ...
  mode: "compaction",
  agent: "compaction",
  summary: true,           // this flag is critical for filterCompacted()
  // ...
}
```

### Overflow during compaction

If the head itself is too large to fit in context for summarisation, the system detects the recursive overflow:

```typescript
// compaction.ts:354-363
if (result === "compact") {
  processor.message.error = new MessageV2.ContextOverflowError({
    message: replay
      ? "Conversation history too large to compact - exceeds model context limit"
      : "Session too large to compact - context exceeds model limit even after stripping media",
  }).toObject()
  processor.message.finish = "error"
  yield* session.updateMessage(processor.message)
  return "stop"
}
```

This prevents infinite compaction loops.

### Overflow-triggered replay

When compaction is triggered by an overflow (the LLM was mid-stream when it exceeded context), the system does something clever: it finds the user message that caused the overflow and **replays** it after compaction:

```typescript
// compaction.ts:242-258
if (input.overflow) {
  const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
  for (let i = idx - 1; i >= 0; i--) {
    const msg = input.messages[i]
    if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
      replay = { info: msg.info, parts: msg.parts }
      messages = input.messages.slice(0, i)  // summarise everything before it
      break
    }
  }
}
```

After compaction completes, the original user message is re-inserted with a fresh ID and timestamp, so the LLM sees it as a new request and can try again with the compacted context. Media attachments are replaced with text placeholders since they may have contributed to the overflow.

### Auto-continue

When compaction finishes and it was auto-triggered (not user-initiated), the system injects a synthetic user message to prompt the LLM to continue:

```typescript
// compaction.ts:429-444
const text =
  (input.overflow
    ? "The previous request exceeded the provider's size limit..."
    : "") +
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."

yield* session.updatePart({
  // ...
  type: "text",
  metadata: { compaction_continue: true },  // internal marker
  synthetic: true,                           // not a real user message
  text,
})
```

A plugin hook `experimental.compaction.autocontinue` can disable this behavior.

## Stage 4: Message Filtering (Read Path)

**File**: `message-v2.ts:1044-1069`

When the prompt loop loads messages for the next LLM call, it uses `filterCompactedEffect` which applies `filterCompacted()` to the raw message stream.

### The filterCompacted algorithm

This is a **reverse-direction scan** that determines which messages the LLM should see:

```typescript
// message-v2.ts:1044-1069
export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined

  for (const msg of msgs) {
    result.push(msg)

    if (retain) {
      if (msg.info.id === retain) break    // found the tail start, stop here
      continue                              // skip to tail start
    }

    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find(
        (item): item is CompactionPart => item.type === "compaction"
      )
      if (!part) continue
      if (!part.tail_start_id) break       // no tail, stop after summary
      retain = part.tail_start_id          // jump to tail
      if (msg.info.id === retain) break
      continue
    }

    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)     // mark the compaction user msg as "has summary"
  }
  result.reverse()
  return result
}
```

Messages are streamed from the database in **reverse chronological order** (newest first). The algorithm:

1. Collects messages into `result`, walking from newest to oldest
2. When it finds a completed summary message (`summary: true`, finished, no error), it records its parent user message ID in `completed`
3. When it reaches that parent user message and finds a `CompactionPart`:
   - If there's a `tail_start_id`, it fast-forwards to that message (skipping everything between the summary and the tail)
   - If there's no `tail_start_id`, it stops (the summary replaces everything older)
4. The result is reversed to chronological order

### What the LLM sees after compaction

```
[Compaction user message]: "What did we do so far?"
[Summary assistant message]: "## Goal\n..."
[Tail turn 1 - user]: (preserved verbatim)
[Tail turn 1 - assistant]: (preserved verbatim, tool outputs may be pruned)
[Tail turn 2 - user]: (preserved verbatim)
[Tail turn 2 - assistant]: (preserved verbatim)
```

The older messages still exist in SQLite — they're just hidden from the model input. The UI can still display them.

## Integration in the Main Loop

Here's how the stages connect in `prompt.ts`'s `runLoop()`:

```typescript
// prompt.ts:1372-1391  —  Process pending compaction task
if (task?.type === "compaction") {
  const result = yield* compaction.process({
    messages: msgs,
    parentID: lastUser.id,
    sessionID,
    auto: task.auto,
    overflow: task.overflow,
  })
  if (result === "stop") break
  continue   // re-loop with compacted context
}

// prompt.ts:1384-1391  —  Detect overflow after normal processing
if (
  lastFinished &&
  lastFinished.summary !== true &&
  (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
) {
  yield* compaction.create({   // inserts CompactionPart, loops back to task handler above
    sessionID, agent: lastUser.agent, model: lastUser.model, auto: true
  })
  continue
}

// prompt.ts:1515-1523  —  Detect overflow from stream processor result
if (result === "compact") {
  yield* compaction.create({
    sessionID,
    agent: lastUser.agent,
    model: lastUser.model,
    auto: true,
    overflow: !handle.message.finish,  // true if LLM was mid-stream
  })
}
```

## Configuration

All compaction behaviour is configurable via `opencode.json`:

```jsonc
{
  "compaction": {
    "auto": true,                    // enable/disable auto-compaction (default: true)
    "prune": true,                   // enable/disable tool output pruning (default: true)
    "tail_turns": 2,                 // recent turns to keep verbatim (default: 2)
    "preserve_recent_tokens": 8000,  // max tokens for preserved tail (default: 25% of usable, clamped to [2K, 8K])
    "reserved": 20000               // token buffer for compaction headroom (default: min(20K, maxOutputTokens))
  }
}
```

## Data Model

### CompactionPart (stored on user messages)

```typescript
{
  type: "compaction",
  auto: boolean,                    // was this auto-triggered?
  overflow?: boolean,               // was this from a context overflow error?
  tail_start_id?: MessageID,        // where to resume including raw messages
}
```

### ToolStateCompleted.time.compacted (stored on tool parts)

```typescript
{
  time: {
    start: number,
    end: number,
    compacted?: number,   // timestamp when output was pruned; undefined = not pruned
  }
}
```

### Assistant message flags

```typescript
{
  summary: true,     // this message is a compaction summary
  mode: "compaction", // created by the compaction agent
  agent: "compaction",
}
```

## Design Trade-offs and Observations

**Strengths:**

- **Multi-phase is smart**: Pruning tool outputs first is cheap and often sufficient. Full summarisation only triggers when needed. This avoids unnecessary LLM calls.
- **Tail preservation keeps the LLM grounded**: By keeping recent turns verbatim, the LLM doesn't lose track of what it just did or what the user just asked. The summary only covers older context where exact wording matters less.
- **Overflow replay is clever**: Re-inserting the user's original message after compaction means the user doesn't have to repeat themselves when the context overflows mid-response.
- **Plugin hooks for customisation**: The `experimental.session.compacting` hook lets plugins inject additional context or replace the compaction prompt entirely. The `experimental.compaction.autocontinue` hook lets plugins control whether auto-continue fires.
- **Non-destructive**: Old messages and tool outputs are never deleted from SQLite. Pruning just sets a timestamp; filtering just hides messages from the model. The full history is always recoverable.

**Weaknesses:**

- **Crude token estimation**: `chars / 4` is a rough heuristic. For code-heavy conversations with lots of JSON tool outputs, this could significantly undercount tokens, potentially triggering compaction too late or estimating tail budgets incorrectly.
- **Summary quality is unverified**: There's no validation that the compaction summary actually preserves the critical information. If the summary misses a key constraint or instruction, the agent may silently lose it.
- **Single compaction model**: The compaction agent uses the same model as the conversation (unless overridden in agent config). For expensive models like Opus, this means paying premium prices for summarisation. No option to use a cheaper model for compaction by default.
- **No incremental compaction**: Each compaction summarises the entire head from scratch. In a very long conversation with multiple compaction cycles, earlier summaries are re-summarised, potentially losing fidelity with each pass.
- **Tail budget may be too small**: 8K tokens maximum for the tail means a single large tool call in the most recent turn could blow the budget, causing the system to fall back to summarising everything (no tail preservation).
- **No tool output recovery**: Once tool outputs are pruned (replaced with `"[Old tool result content cleared]"`), the LLM cannot re-read them without re-executing the tool. There's no mechanism to selectively restore pruned outputs.
