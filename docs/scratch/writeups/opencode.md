# OpenCode — Architecture Analysis

> OpenCode is an open-source, provider-agnostic AI coding agent built in TypeScript on Bun. It distinguishes itself with a TUI-first design (powered by a custom OpenTUI framework), a client/server architecture that decouples compute from frontend (supporting CLI, desktop, and web clients simultaneously), and an extensive provider ecosystem (30+ LLM providers via the Vercel AI SDK). The codebase is a large Bun monorepo with 19 packages spanning CLI, web app, desktop (Electron), console/enterprise backend, plugin SDK, and cloud infrastructure (Cloudflare Workers + SST).

## Overview

| Attribute | Detail |
|-----------|--------|
| Language | TypeScript 5.8.2 (Bun 1.3.13 runtime) |
| LLM Provider(s) | 30+: Anthropic, OpenAI, Google, Azure, Bedrock, Vertex, Mistral, Groq, xAI, OpenRouter, Cohere, Perplexity, GitLab, Cloudflare Workers AI, and more |
| License | MIT |
| Repository | github.com/anomalyco/opencode |
| Version | 1.14.20 |
| Distribution | npm, Homebrew, Scoop, Choco, AUR, Nix, Mise, Electron desktop app |

## Architecture

OpenCode follows a **client/server monorepo** architecture. A single Bun-based server manages sessions, LLM streaming, tool execution, and persistence. Multiple frontends (TUI, web app, Electron desktop) connect to this server via the ACP (Agent Client Protocol) layer.

```
┌─────────────────────────────────────────────────────────┐
│                      Clients                            │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │   TUI   │  │ Web App  │  │ Desktop  │  │  Slack  │ │
│  │(OpenTUI)│  │(Solid.js)│  │(Electron)│  │  Bot    │ │
│  └────┬────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│       └─────────┬──┴────────────┬┘              │      │
│                 ▼               ▼               ▼      │
│          ┌──────────────────────────────┐              │
│          │     ACP Protocol Layer       │              │
│          │  (Agent Client Protocol)     │              │
│          └──────────┬───────────────────┘              │
└─────────────────────┼──────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────┐
│                    Core Server                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │              Session Manager                      │  │
│  │  ┌────────┐  ┌────────────┐  ┌───────────────┐  │  │
│  │  │ Prompt │→ │  LLM Layer │→ │   Processor   │  │  │
│  │  │  Loop  │  │(AI SDK v6) │  │ (Event Stream)│  │  │
│  │  └────────┘  └────────────┘  └───────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────┐ ┌────────────┐ ┌──────┐ ┌────────────┐  │
│  │  Tool    │ │ Permission │ │ MCP  │ │   Plugin   │  │
│  │ Registry │ │  Service   │ │Bridge│ │   System   │  │
│  └──────────┘ └────────────┘ └──────┘ └────────────┘  │
│                                                         │
│  ┌──────────┐ ┌────────────┐ ┌──────┐ ┌────────────┐  │
│  │  SQLite  │ │  Provider  │ │ LSP  │ │  Config    │  │
│  │(Drizzle) │ │  Registry  │ │Bridge│ │  Service   │  │
│  └──────────┘ └────────────┘ └──────┘ └────────────┘  │
└─────────────────────────────────────────────────────────┘
```

The entire backend is built on the **Effect** library for functional dependency injection, resource management, and composable error handling. This is a defining architectural choice — every service, tool, and subsystem is an Effect `Layer` composed at startup.

## Core Components

### Session Manager (`packages/opencode/src/session/`)

The session is the central unit of state. Each session has a SQLite-backed record with messages, parts (text, tools, reasoning, compaction), permissions, and diff summaries. Sessions support:

- **Parent/child hierarchy** for subagent sessions
- **Forking** with full message history copying
- **Cursor-based pagination** for efficient large session retrieval
- **SyncEvent system** for real-time broadcast of state changes

### Prompt Loop (`packages/opencode/src/session/prompt.ts`)

The main execution engine is `runLoop()` — a `while(true)` loop that:

1. Loads the latest messages
2. Checks exit conditions (no pending tool calls, user message after last assistant)
3. Creates an assistant message and streams LLM output
4. Processes tool calls inline as the LLM generates them
5. Re-loops if the LLM's finish reason is `"tool-calls"`
6. Triggers compaction if context overflow is detected

```typescript
while (true) {
  yield* status.set(sessionID, { type: "busy" })
  let msgs = yield* MessageV2.filterCompactedEffect(sessionID)

  // Exit if assistant finished and no tool calls pending
  if (lastAssistant?.finish && !["tool-calls"].includes(...) && ...) {
    break
  }

  const handle = yield* processor.create({ assistantMessage: msg, ... })
  const result = yield* handle.process({ user, agent, system, messages, tools, model })

  if (result === "compact") {
    yield* compaction.create({ ... })
  }
  // continue loop
}
```

### Processor (`packages/opencode/src/session/processor.ts`)

Handles the streaming event pipeline from the Vercel AI SDK. Processes 20+ event types (`text-delta`, `tool-call`, `tool-result`, `reasoning-delta`, `finish`, etc.) and translates them into persistent message parts stored in SQLite. Includes:

- **Doom loop detection**: Tracks the last 3 tool calls; if all three are identical (same tool, same input), it pauses for user approval
- **250ms tool settlement timeout** during cleanup to avoid hanging on incomplete tool calls
- **Structured output support** via injected StructuredOutput tool for `json_schema` format

### ACP Agent Layer (`packages/opencode/src/acp/agent.ts`)

The public-facing protocol layer that external clients connect to. Handles:
- Prompt routing (text, images, MCP resources)
- Slash command parsing and dispatch
- Event bridging (session events → client-facing updates)
- Tool call status streaming with kind classification (`edit`, `execute`, `search`, etc.)

## LLM Integration

### Provider Abstraction

OpenCode uses the **Vercel AI SDK v6** as its foundation, wrapping it with an Effect-based `Provider.Service` that provides:

- **Dynamic SDK resolution**: Providers are loaded lazily from bundled packages or dynamically installed via npm at runtime
- **SDK caching**: Resolved SDKs are cached by a hash of `(providerID, npm package, options)`
- **Model metadata**: Fetched from `models.dev` with a 5-minute TTL local cache, providing rich metadata (capabilities, cost, context limits, modalities)

### Prompt Management

System prompts are **model-family-aware**. A router in `session/system.ts` selects from provider-specific prompt files:

| Model Family | Prompt File |
|-------------|-------------|
| Claude | `prompt/anthropic.txt` |
| GPT-4/o1/o3 | `prompt/beast.txt` |
| GPT (other) | `prompt/gpt.txt` |
| Gemini | `prompt/gemini.txt` |
| Kimi | `prompt/kimi.txt` |
| Default | `prompt/default.txt` |

The final prompt is 3-part layered: agent/provider prompt, custom context, and per-message user system instructions. A caching optimization rejoins parts to maintain a 2-part structure when the header hasn't changed between turns.

### Prompt Caching

Ephemeral cache control headers are applied to the first 2 system messages and last 2 user messages, with provider-specific header formats:

```typescript
const providerOptions = {
  anthropic: { cacheControl: { type: "ephemeral" } },
  bedrock:   { cachePoint: { type: "default" } },
  copilot:   { copilot_cache_control: { type: "ephemeral" } },
  // ...
}
```

Session IDs serve as stable cache keys for per-conversation caching (OpenAI, Azure, OpenRouter, Venice).

### Streaming

LLM output is streamed via Effect's `Stream` monad wrapping the AI SDK's `streamText()`. A custom SSE wrapper adds per-chunk timeout support (`chunkTimeout` option) that aborts if no data arrives within the configured interval — useful for detecting stalled provider connections.

### Reasoning Model Support

Three thinking modes are supported:
- **Extended Thinking** (OpenAI o1/o3, Anthropic Opus) with effort levels
- **Adaptive Thinking** (Anthropic with token budgets)
- **Interleaved Thinking** (Anthropic with separate reasoning output fields)

### Message Normalization

A transform pipeline in `provider/transform.ts` handles provider differences:
1. Filter unsupported modalities per model
2. Provider-specific message restructuring (Anthropic empty content filtering, Mistral format, interleaved reasoning)
3. Cache control header injection
4. Provider options key remapping (stored providerID → SDK-expected key)

## Tool System

### Built-in Tools (17+)

| Tool | Purpose |
|------|---------|
| `bash` | Shell command execution with tree-sitter permission scanning |
| `read` | File/directory/image/PDF reading |
| `write` | File creation with diff generation |
| `edit` | Structured file editing |
| `glob` | File pattern matching |
| `grep` | Content search with regex |
| `webfetch` | URL fetching (HTML → markdown via Turndown) |
| `websearch` | Web search via Exa API |
| `question` | Interactive user questions |
| `todowrite` | Todo list management |
| `skill` | Load specialized skill instructions |
| `task` | Subagent spawning for parallel execution |
| `apply_patch` | Unified diff application (used by GPT models instead of edit/write) |
| `codesearch` | Semantic code search |
| `lsp` | Language Server Protocol operations |
| `plan` | Plan mode operations |
| `invalid` | Fallback for unknown tool calls |

### Registration and Dispatch

Tools are registered via Effect layers in `tool/registry.ts`. The registry provides:
- `tools(model, agent)` — returns filtered tools based on model type (e.g., GPT gets `apply_patch` instead of `edit`/`write`), feature flags, and agent permissions
- **Plugin tool loading** — scans `{tool,tools}/*.{js,ts}` directories for custom tool definitions
- **MCP tool conversion** — translates MCP tool definitions into the internal format

### Execution Flow

```
LLM generates tool call → Processor receives event
  → Permission check (ctx.ask with permission type + patterns)
    → "allow": execute immediately
    → "ask": publish Event.Asked, block until user replies
    → "deny": throw DeniedError
  → Tool.execute(args, context) runs
  → Result stored as ToolPart in SQLite
  → Output truncated per agent config
  → Plugin hooks fire (tool.execute.before / tool.execute.after)
  → LLM continues with tool result
```

### Bash Tool Details

The bash tool deserves special mention for its sophistication:
- **Tree-sitter parsing** of bash/PowerShell commands to extract file operations
- **Permission scanning** identifies `cd`, `rm`, `cp`, `mv`, `mkdir`, etc. and their target paths
- **Cross-platform** via `cross-spawn` with bash/zsh/fish/PowerShell/cmd.exe support
- **Configurable timeout**: default 2 minutes, overridable per command and globally

### Tool Call Repair

A `experimental_repairToolCall` callback handles malformed LLM tool calls by normalizing tool name casing — if the LLM outputs `"Bash"` instead of `"bash"`, the system auto-corrects.

## Planning & Reasoning

### Execution Pattern: Streaming Tool Loop

OpenCode uses a **streaming-first tool execution loop** — not pure ReAct, not plan-then-execute. Each loop iteration generates one assistant turn via `streamText()`. Tools execute inline as the LLM calls them. The loop continues when the finish reason is `"tool-calls"` and breaks on `"stop"` or structured output completion.

### Agent Types

| Agent | Mode | Purpose |
|-------|------|---------|
| `build` | primary | Default agent, full tool access |
| `plan` | primary | Read-only analysis, restricted to plan files |
| `general` | subagent | Multi-step parallel research |
| `explore` | subagent | Fast codebase search specialist |
| `compaction` | primary (hidden) | Conversation summarization |
| `summary` | primary (hidden) | Session title generation |

### Subagent Spawning

The `task` tool enables recursive subagent execution. When invoked:
1. Creates a child session (linked via `parentID`)
2. Applies permission restrictions (inherits or restricts parent permissions)
3. Calls `ops.prompt()` which re-enters the full loop system
4. Returns the subagent's output wrapped in `<task_result>` tags
5. Supports resumption via `task_id` parameter

Subagents are genuinely recursive — they run the complete prompt loop, can use tools, and could theoretically spawn their own subagents (though this can be restricted via permission rules).

## Memory & Context Management

### Persistence Layer

- **SQLite with WAL mode** as the primary database (via Drizzle ORM)
- Three core tables: `MessageTable` (metadata), `PartTable` (content), `SessionTable` (session state)
- Pragmatic configuration: 64MB cache, 5s busy timeout, foreign keys enabled
- Cursor-based pagination with generator-based streaming (50 messages per batch)

### Context Window Strategy

A 3-phase compaction system manages context overflow:

**Phase 1 — Tool Output Pruning** (`prune()`):
- Walks backward through messages, skipping the 2 most recent user turns
- Marks old tool outputs as compacted when cumulative tokens exceed `PRUNE_PROTECT` (40K tokens)
- Protected tools (like `skill`) are never pruned

**Phase 2 — Turn Selection** (`select()`):
- Calculates a budget for recent messages (2K–8K tokens, or 25% of usable context)
- Keeps the N most recent turns (default 2) that fit within budget
- Everything before the kept turns becomes the "head" to be summarized

**Phase 3 — Summary Generation** (`process()`):
- Spawns the hidden `compaction` agent with a structured summary template
- Template captures: Goal, Instructions, Discoveries, Accomplished work, Relevant files
- The summary replaces old messages; a `tail_start_id` preserves where old context was pruned
- `filterCompacted()` transparently hides pruned content from the model

### Token Tracking and Cost

Token usage is tracked per assistant message with provider-aware extraction (handles different token metadata formats across Anthropic, OpenAI, Vertex, Bedrock, Venice). Cost calculation uses `Decimal.js` for precision, with special pricing for >200K input contexts.

## Error Handling & Recovery

### Retry System

**Retry detection** (`session/retry.ts`):
- 500+ status codes always retried regardless of SDK marking
- Rate limit detection via text patterns ("Overloaded", "rate limit", "too many requests") and JSON error body parsing
- Context overflow errors explicitly excluded from retries
- Free usage limit errors return a special upsell message

**Backoff strategy**:
- Respects server `retry-after-ms` and `retry-after` headers (including HTTP date parsing)
- Exponential backoff: `2000ms * 2^(attempt-1)`, capped at 30 seconds
- Applied via Effect's `retry()` combinator wrapping the entire LLM stream

### Error Classification

Seven structured error types via discriminated union:
`AuthError | Unknown | OutputLengthError | AbortedError | StructuredOutputError | ContextOverflowError | APIError`

Each includes name, message, cause, and structured metadata. Error state is tracked at both the part level (`RetryPart`, `ToolStateError`) and the message level (`Assistant.error`).

### Doom Loop Prevention

Tracks the last 3 tool parts. If all three share the same tool name and identical input, execution pauses and requests explicit user approval via the `doom_loop` permission.

## Security & Sandboxing

### Permission System

A **rule-based permission system** with wildcard pattern matching:

```typescript
// Rule structure
{ permission: "edit", pattern: "*.env", action: "deny" }
{ permission: "bash", pattern: "rm *", action: "ask" }
```

Evaluation uses **last-match-wins** semantics — more specific rules override wildcards. Three actions: `allow` (silent), `ask` (blocks for user approval), `deny` (throws `DeniedError`).

Permission rules are hierarchical:
1. **Defaults**: baseline safeguards (deny `.env` reads, deny question tool)
2. **Agent-specific**: each agent defines its own ruleset
3. **User-configured**: config file overrides
4. **Session-scoped**: per-prompt tool restrictions

### No Process Isolation

OpenCode does **not** use containers, namespaces, or syscall filtering. Bash commands execute with full user privileges. Security relies entirely on the permission rule system evaluated before execution.

### Filesystem Protection

A blocklist of sensitive directories prevents access to:
- **macOS**: `~/Library/{AddressBook,Calendars,Mail,Messages,Safari,Cookies,TCC}`, `~/Downloads`, `~/Desktop`, etc.
- **Windows**: `AppData`, `Downloads`, `Desktop`, `Documents`, etc.

### Permission Denial Flow

When a user rejects a permission request:
- The specific tool call is marked as `"error"` status
- **Cascading rejection**: all other pending permission requests in the same session are also rejected
- The processor sets `ctx.blocked = true` (configurable via `continue_loop_on_deny`)
- The loop returns `"stop"` to halt execution

## Extensibility

### Plugin System

Plugins are loaded from npm packages or local files and register hooks into the system:

**Hook categories**:
- **Chat hooks**: `chat.params` (modify temperature, topP, etc.), `chat.headers` (inject HTTP headers), `chat.message`
- **Tool hooks**: `tool.execute.before`, `tool.execute.after`, `tool.definition` (modify tool schemas)
- **System hooks**: `experimental.chat.system.transform` (modify system prompt), `experimental.chat.messages.transform`
- **Permission hooks**: `permission.ask` (intercept permission requests)
- **Shell hooks**: `shell.env` (inject environment variables)
- **Auth hooks**: OAuth and API key configuration
- **Provider hooks**: dynamic provider/model registration

7 built-in plugins handle auth for Codex, Copilot, GitLab, Poe, Cloudflare Workers, and Cloudflare AI Gateway.

### MCP Integration

Full Model Context Protocol support with both local (stdio) and remote (HTTP/SSE with OAuth) servers. MCP tools are converted to the internal tool format and namespaced by server name (e.g., `brave:web_search`). Supports tool discovery, prompt listing, resource listing, and OAuth authentication flows.

### Custom Tools

Users can add tools by placing `{tool,tools}/*.{js,ts}` files in project directories. Tools are dynamically imported and wrapped with the plugin tool interface:

```typescript
type ToolDefinition = {
  description: string
  args: Zod schema
  execute: (args, context) => Promise<string | { output: string; metadata?: {} }>
}
```

### Custom Agents and Commands

- **Agents**: Markdown files with YAML frontmatter in `{agent,agents}/**/*.md` directories
- **Commands**: Markdown files in `{command,commands}/**/*.md` with template, description, agent, and model fields
- **Skills**: Loadable via the `skill` tool from local paths or remote URLs

### Configuration

Hierarchical config merging from 7+ sources: global (`~/.opencode/`), well-known remote, project-level, `.opencode` directory, environment variables, managed preferences (macOS MDM), and console remote config.

## Dependencies & Tech Stack

| Category | Library | Purpose |
|----------|---------|---------|
| Runtime | Bun 1.3.13 | JS runtime and package manager |
| Build | Turbo 2.8.13 | Monorepo build orchestration |
| Core Framework | Effect 4.0.0-beta.48 | Functional DI, resource management, error handling |
| LLM Integration | Vercel AI SDK v6 | Provider-agnostic LLM streaming |
| UI Framework | Solid.js 1.9.10 | Web/desktop reactive UI |
| Terminal UI | OpenTUI 0.1.99 | Custom TUI component framework |
| Database | Drizzle ORM 1.0.0-beta | Type-safe SQLite ORM |
| Web Framework | Hono 4.10.7 | HTTP server for workers/API |
| Schema | Zod 4.1.8 | Runtime validation |
| Code Parsing | Tree-sitter 0.25.10 | Bash/PowerShell command analysis |
| Desktop | Electron | Cross-platform desktop app |
| Infrastructure | SST 3.18.10 | Cloudflare Workers deployment |
| MCP | @modelcontextprotocol/sdk 1.27.1 | Model Context Protocol client |
| Git/GitHub | Octokit 22.0.0 | GitHub API integration |

## Strengths

- **Provider breadth**: 30+ LLM providers with automatic model metadata from models.dev — trivially switch between Claude, GPT, Gemini, or local models
- **Client/server separation**: The ACP layer genuinely decouples frontend from compute, enabling CLI, web, desktop, and Slack clients to share the same session server
- **Effect-based architecture**: Provides composable, type-safe dependency injection and resource management throughout — tools, services, and the runtime are all Effect layers that compose cleanly
- **Sophisticated context management**: The 3-phase compaction system (prune tool outputs → select tail turns → AI-generated summary) is more nuanced than simple truncation
- **Prompt caching awareness**: Cache control headers applied per-provider with session-ID-based cache keys; prompt structure maintained to maximize cache hits
- **Plugin hook coverage**: 15+ hook points covering system prompts, chat parameters, tool execution, permissions, and environment — plugins can meaningfully alter agent behaviour
- **Model-aware prompt selection**: Different system prompts per model family, with reasoning mode support for extended/adaptive/interleaved thinking
- **Tree-sitter command analysis**: Bash tool parses commands to extract file operations for granular permission checks, rather than just pattern-matching on the raw command string
- **Doom loop detection**: Simple but effective guard against infinite tool call loops

## Limitations

- **No process isolation**: Bash commands run with full user privileges. Security relies entirely on permission rules — a sufficiently creative prompt injection could bypass rule-based checks since there's no sandbox boundary
- **Heavy dependency on Effect**: The entire codebase is written in Effect's functional style. This is powerful for composition but creates a steep learning curve for contributors unfamiliar with Effect's monadic patterns
- **Large surface area**: 19 packages, 21 CLI commands, cloud infrastructure, enterprise features, Slack bot — the codebase is significantly larger than most coding agents, making it harder to reason about holistically
- **No offline model metadata**: Model capabilities are fetched from models.dev with only a 5-minute TTL cache — if the service is unavailable, model discovery may be impaired
- **Permission system is pre-execution only**: Permissions are checked before tool execution but don't constrain what happens during execution — a bash command that passes permission scanning could still perform unexpected operations
- **SQLite single-writer**: WAL mode helps but SQLite is still single-writer, which could bottleneck under heavy concurrent subagent use
- **Plugin API is partially experimental**: Several hook points are prefixed `experimental.*`, suggesting the plugin API surface isn't fully stabilized

## Key Takeaways for Our Agent

- **Prompt caching is table stakes**: OpenCode applies ephemeral cache control to the first 2 system messages and last 2 user messages, with per-provider header formats and session-ID cache keys. Any agent that doesn't optimize for prompt caching is burning money.

- **Context compaction should be multi-phase**: Rather than simply truncating at a token limit, OpenCode's approach of first pruning old tool outputs, then selecting recent turns to preserve, then generating a structured AI summary preserves more useful context per token. The structured summary template (Goal, Instructions, Discoveries, Accomplished, Files) is particularly worth adopting.

- **Tree-sitter for command analysis**: Parsing bash commands with tree-sitter to extract file operations for permission checks is significantly more robust than regex-based command scanning. Worth considering for any agent that needs to reason about shell command safety.

- **Subagent sessions should be first-class**: OpenCode's approach of giving each subagent its own session (with parent linking, inherited permissions, and resumability via `task_id`) is cleaner than trying to multiplex subagent state within a single conversation. The permission inheritance model is also well-designed.

- **Provider normalization is harder than it looks**: The `transform.ts` file handling message normalization across providers (empty content filtering for Anthropic, interleaved reasoning, provider options key remapping) is substantial. Any multi-provider agent should budget significant effort for this layer rather than assuming the AI SDK handles everything.
