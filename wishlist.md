# Feature Wishlist

Ideas and design sketches for our coding agent, collected from analysing other agents and from our own observations. These aren't commitments — they're starting points for design conversations. Each entry captures the problem, a rough solution shape, and open questions.

---

## Core decisions

- **TypeScript** — primary language
- **TUI** — terminal UI is the primary interface
- **Vercel AI SDK** — use for provider abstraction (model routing, streaming, tool calling)
- **Extensibility** — hooks (like Claude Code) or plugins (like OpenCode), TBD which model
- **Programmatic API** — the agent should be usable both as a TUI for interactive use and as a library/service with a clean programmatic interface. A household AI agent (or any other orchestrator) should be able to spin up a coding session, send prompts, receive results, and manage sessions without needing to drive a terminal. The TUI and the programmatic API should share the same core — the TUI is just one frontend.
- **Simplicity** — keep the architecture simple like pi-agent; avoid the complexity explosion of OpenCode's 19-package monorepo. A coding agent doesn't need an Electron app, Slack bot, enterprise console, and cloud infrastructure to be good. Start with a single package that does the core loop well.

---

## Retrievable pruned tool outputs

### Problem

When a long conversation exceeds the context window, tool outputs need to be evicted. The naive approach (OpenCode's current design) replaces old outputs with a static placeholder like `"[Old tool result content cleared]"`. The original data still exists in storage but is permanently invisible to the model. If the LLM later needs that information — to compare before/after states, reference earlier analysis, or check a value it read 20 turns ago — it has to re-execute the tool from scratch.

Re-execution is wasteful and sometimes impossible:
- The file may have changed since the original read
- The command output may be non-deterministic or destructive
- The web page may no longer be available
- The original tool call may have been expensive (large grep, slow API)

### Idea

Instead of replacing pruned outputs with a dead-end placeholder, move them to a document store and replace the output with a retrieval ID. Give the LLM a tool (e.g. `recall`) that fetches a pruned output by ID.

The flow:

```
Before pruning:
  tool_call: read { path: "/src/config.ts" }
  output: "import { z } from 'zod'\n..."  (2,400 tokens)

After pruning:
  tool_call: read { path: "/src/config.ts" }
  output: "[Result archived — retrieve with: recall({ id: 'pr_a1b2c3' })]"  (20 tokens)
```

The LLM sees the tool was called and what arguments were used, so it has the semantic context ("I read config.ts earlier"). If it needs the actual content, it calls `recall("pr_a1b2c3")` — one cheap tool call instead of re-reading the file (which may have changed).

### Design sketch

**Storage**: A simple key-value store keyed by a short ID (e.g. `pr_` prefix + hash). Could be SQLite (already available), a separate table, or even flat files. Doesn't need to be fancy — these are write-once, read-occasionally.

**Pruning**: When marking a tool output as compacted, also write the full output to the store and replace the output text with the retrieval stub.

**Recall tool**: A new tool that takes an ID and returns the stored output. Should be cheap — no permission prompts needed (the data was already approved when the original tool ran). Consider truncation if the recalled output is very large.

**Eviction**: Stored outputs can be garbage-collected when the session is archived or after a configurable TTL. No need to keep them forever.

### Open questions

- **Should recall return the full output or a summary?** For very large outputs (e.g. a 5,000-line file read), returning the full thing defeats the purpose. Could offer both: `recall(id)` for full output, or let the LLM specify a line range or search within the stored output.
- **Should the LLM know about recall proactively?** The retrieval stub tells it the tool exists, but should `recall` appear in the tool list from the start, or only after the first pruning event? Keeping it out of the tool list until needed saves a few tokens in the tool schema.
- **How does this interact with compaction summaries?** If the compaction summary already captures the key facts from a tool output, recalling the raw output might be redundant. Could the summary generation step be made aware of which outputs are retrievable vs. gone?
- **ID stability**: If multiple compaction cycles run, does the same output get a new ID each time, or is the ID stable? Stable IDs are simpler but require dedup logic.
- **Multi-session access**: Should subagent sessions be able to recall outputs from the parent session's store? Probably yes, since subagents often need context from the parent conversation.
