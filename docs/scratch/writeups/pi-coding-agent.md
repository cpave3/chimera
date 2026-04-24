# Pi Coding Agent — Architecture Analysis

> Pi is a full-featured, open-source coding agent built in TypeScript as part of the `pi-mono` monorepo by Mario Zechner (badlogic). It provides an interactive terminal UI, an RPC protocol for IDE integration, and an embeddable SDK — all sharing a single `AgentSession` core. Its standout quality is the depth of its extension system: extensions can intercept virtually every lifecycle event, register custom tools, add LLM providers, and render custom UI components. The agent uses a ReAct-style loop where the LLM decides each action based on accumulated context, with automatic compaction to manage long conversations.

## Overview

| Attribute | Detail |
|-----------|--------|
| Language | TypeScript (strict mode, ES modules) |
| Runtime | Node.js >=20, optional Bun binary compilation |
| LLM Provider(s) | Anthropic, OpenAI, Google, Mistral, OpenRouter, plus custom providers via extensions |
| License | Open source (monorepo) |
| Repository | https://github.com/badlogic/pi-mono |
| Package | `packages/coding-agent` (0.68.1), CLI binary: `pi` |

## Architecture

The agent is structured as a monorepo with four core packages, where the coding-agent orchestrates the others:

```
┌─────────────────────────────────────────────────┐
│                   coding-agent                   │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │Interactive│  │   RPC    │  │  Print / SDK  │ │
│  │   Mode    │  │   Mode   │  │     Mode      │ │
│  └─────┬─────┘  └────┬─────┘  └──────┬────────┘ │
│        └──────────────┼───────────────┘          │
│                 ┌─────┴──────┐                   │
│                 │AgentSession│                   │
│                 └─────┬──────┘                   │
│    ┌──────┬───────────┼───────────┬──────┐       │
│    │Tools │Extensions │Compaction │Skills│       │
│    └──┬───┘    └──┬───┘    └──┬───┘  └┬──┘      │
├───────┼───────────┼───────────┼───────┼──────────┤
│  pi-agent-core    │      pi-ai        │  pi-tui  │
│  (agent loop,     │    (LLM API       │  (TUI    │
│   state, tools)   │   abstraction)    │  render) │
└───────────────────┴───────────────────┴──────────┘
```

**Dependency graph:**
- `coding-agent` → `pi-ai`, `pi-agent-core`, `pi-tui`
- `pi-agent-core` → `pi-ai`
- `pi-tui` and `pi-ai` are independent

**Key architectural pattern:** All four run modes (interactive, print, RPC, SDK) share a single `AgentSession` class. Modes differ only in how they present I/O. This means features like compaction, session branching, and extensions work identically regardless of interface.

### Main Execution Loop

The core loop lives in `pi-agent-core` (`packages/agent/src/agent-loop.ts`) and implements a **ReAct pattern** with two nested loops:

```
OUTER LOOP (follow-up messages):
  INNER LOOP (tool calls + steering):
    1. Stream assistant response from LLM
    2. If error/aborted → exit
    3. Extract tool calls from response
    4. Execute tools (sequential or parallel)
    5. Check for steering messages (mid-run user interruption)
    6. If more tool calls or steering → loop inner
  7. Check for follow-up messages (queued while agent was busy)
  8. If follow-ups → loop outer
  9. Done → emit agent_end
```

The LLM makes all decisions — the loop simply executes whatever tools the model requests, feeds results back, and repeats until the model stops calling tools and no messages are queued.

## Core Components

### AgentSession (`src/core/agent-session.ts`, ~3000 lines)

The central orchestration layer shared across all modes. Manages:
- Model selection and thinking level configuration
- Tool registration and activation
- Session lifecycle (prompt → stream → tools → persist)
- Auto-compaction when context approaches limits
- Auto-retry with exponential backoff for transient errors
- Context overflow recovery (compact then retry)
- Branch navigation and summarization

### Agent Loop (`packages/agent/src/agent-loop.ts`, 664 lines)

The low-level ReAct loop. Key features:
- **Steering queue**: Users can inject messages mid-turn to redirect the agent
- **Follow-up queue**: Messages queued while agent is busy, processed after current tool chain completes
- **Tool execution modes**: Sequential (default) or parallel, configurable per-tool
- **Event emission**: Granular events for every phase (turn_start, message_start/update/end, tool_execution_start/end)

### SessionManager (`src/core/session-manager.ts`, 1426 lines)

Persistence layer using append-only JSONL files with a tree structure:
- Each entry has `id` and `parentId`, forming a DAG
- Entries are immutable once written — no modification or deletion
- Supports branching: navigate to any point in the tree and continue from there
- Branch summarization: when leaving a branch, an LLM-generated summary is injected as context
- Session forking: create independent session files inheriting history
- Auto-migration from v1 (linear) → v2 (tree) → v3 (current)

File location: `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<sessionId>.jsonl`

### Extension System (`src/core/extensions/`, ~2000 lines)

Three files form the extension infrastructure:
- **types.ts** (1501 lines): Complete type definitions for the extension API, 19+ event types, tool definitions, UI context
- **loader.ts**: Discovery from `~/.pi/extensions/`, `.pi/extensions/`, and configured paths; uses `jiti` for dynamic TS/JS loading
- **runner.ts**: Event dispatch, handler lifecycle, error isolation (extension failures don't crash agent)

## LLM Integration

### Provider Abstraction

The `pi-ai` package provides a unified streaming API across providers. The coding-agent's `ModelRegistry` (`src/core/model-registry.ts`) manages:
- Built-in providers via `pi-ai`'s `getProviders()` / `getModels()`
- Custom models via `~/.pi/agent/models.json` or `.pi/models.json`
- Runtime provider registration by extensions

The actual LLM call is a callback (`streamFn`) injected at session creation:

```typescript
streamFn: async (model, context, options) => {
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    return streamSimple(model, context, {
        ...options,
        apiKey: auth.apiKey,
        headers: { ...openRouterHeaders, ...auth.headers, ...options?.headers },
    });
},
```

### Prompt Management

System prompt assembly (`src/core/system-prompt.ts`) composes from:
1. Default instruction template ("expert coding assistant in pi...")
2. Available tools with one-liner descriptions
3. Dynamic guidelines based on active tools
4. Documentation references
5. Optional `appendSystemPrompt` from settings or `APPEND_SYSTEM.md`
6. Project context files (CLAUDE.md / AGENTS.md, walked up filesystem)
7. Skills section (XML block with names, descriptions, locations)
8. Current date and working directory

User prompts support **template expansion**: markdown files in `~/.pi/agent/prompts/` with frontmatter, supporting `$1`, `$2`, `$@`, `$ARGUMENTS` substitution.

### Token Management

Token counting uses a simple heuristic: `chars / 4` (conservative overestimate). No tokenizer library is used. This estimate drives compaction decisions and context budget tracking.

Streaming events (`message_start`, `message_update`, `message_end`) carry actual token usage from the provider, used for cost tracking and UI display.

### Context Window Strategy

Provider-reported `contextWindow` per model. When context approaches the limit:
1. **Threshold check**: `contextTokens > contextWindow - reserveTokens` (default reserve: 16,384)
2. **Auto-compaction**: Summarize older messages, keep recent 20K tokens
3. **Overflow recovery**: If LLM returns overflow error, compact then auto-retry (once)

## Tool System

Seven built-in tools, all created via factory functions in `src/core/tools/`:

| Tool | Purpose | Key Detail |
|------|---------|------------|
| `bash` | Shell command execution | Spawns detached process, kills process tree on timeout/abort, output to temp file if >50KB |
| `read` | File reading | Line offset/limit, image detection with auto-resize, macOS NFD path resolution |
| `write` | File creation | Auto-creates parent directories, serialized via mutation queue |
| `edit` | Targeted text replacement | Fuzzy matching (Unicode normalization, smart quotes), overlap detection, reverse-order application |
| `grep` | Pattern search | Uses ripgrep (`rg`), JSON output parsing, line truncation at 500 chars |
| `find` | File search | Uses `fd`, glob patterns, auto-downloads tool if missing |
| `ls` | Directory listing | Sorted, directory suffix, entry limit |

### Tool Registration and Dispatch

Tools implement a `ToolDefinition` interface with TypeBox parameter schemas. A wrapper (`tool-definition-wrapper.ts`) adapts them to `pi-agent-core`'s `AgentTool` interface. Extensions can register additional tools or override built-in ones.

Dispatch flow:
1. LLM returns tool call (name + JSON args)
2. `prepareArguments()` compat shim runs (e.g., edit tool handles JSON-string `edits`)
3. `beforeToolCall` extension hook — can block with reason or mutate arguments
4. `tool.execute()` runs with abort signal and streaming update callback
5. `afterToolCall` extension hook — can modify result content, details, or error flag
6. Tool result message sent back to LLM

### Concurrency

- `bash`: Each call spawns independently, no queue
- `write`/`edit`: Serialized per-file via `withFileMutationQueue()` (uses `realpathSync` to resolve symlinks)
- `read`/`grep`/`find`/`ls`: Fully concurrent, no mutual exclusion

### Output Truncation

Two strategies in `truncate.ts`:
- **`truncateHead()`** (keep first N): Used by read, find, grep, ls. Default: 2000 lines / 50KB
- **`truncateTail()`** (keep last N): Used by bash. Same defaults. Full output saved to temp file with path in tool details

## Planning & Reasoning

**Pattern: Pure ReAct (observe-think-act), no lookahead planning.**

The agent does not plan multi-step sequences. Each LLM turn decides the next action based on the full visible context (system prompt + message history + tool results). The trajectory emerges from repeated cycles.

### Extended Thinking

Configurable thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. The level is passed to the LLM as a `reasoning` parameter. Thinking blocks stream via `thinking_start`/`thinking_delta`/`thinking_end` events and become part of the message history.

Token budgets per thinking level are configurable in settings:
```json
{ "thinkingBudgets": { "minimal": 1024, "low": 4096, "medium": 8192, "high": 16384 } }
```

### Retry and Recovery

Exponential backoff for transient errors (overloaded, rate limit, 5xx, timeout):
- Default: 3 retries, 2s base delay, 60s max delay
- Formula: `baseDelayMs * 2^(attempt-1)`
- Context overflow gets special treatment: compact first, then single auto-retry

### Session Branching

Users can navigate the session tree to any prior point and continue from there. When leaving a branch:
1. Messages from current position back to common ancestor are collected
2. LLM generates a structured summary (goal, progress, decisions, next steps)
3. Summary injected as a `BranchSummaryMessage` in the new path
4. The LLM sees what was explored and abandoned

## Memory & Context Management

### Session Persistence

Sessions are append-only JSONL files with tree structure. Entry types:
- `message` (user, assistant, toolResult, bashExecution, custom, branchSummary, compactionSummary)
- `compaction` (summary text, firstKeptEntryId, token counts, file operation tracking)
- `branch_summary` (summary of abandoned branch)
- `thinking_level_change`, `model_change` (metadata, not sent to LLM)
- `label` (user bookmarks), `session_info` (display name)
- `custom` (extension state persistence)

### Compaction Algorithm

When triggered:
1. **Find cut point**: Walk backward from newest message, accumulating estimated tokens. Stop when `keepRecentTokens` (20K) budget is filled. Only cut at user/assistant/custom messages (never mid-tool-result).
2. **Generate summary**: Send messages-to-summarize to LLM with a structured prompt requesting: Goal, Constraints, Progress (Done/In Progress/Blocked), Key Decisions, Next Steps, Critical Context.
3. **Update mode**: If a previous compaction exists, uses an update prompt that preserves existing information and adds new progress.
4. **Split turn handling**: If cutting mid-turn, generates a separate "turn prefix summary" (50% of token budget) merged into the main summary.
5. **File tracking**: Extracts read/modified files from tool calls, appends as XML tags to summary.

### Cross-Session Memory

**None.** Sessions are fully isolated. Cross-session continuity comes from:
- `settings.json` (user preferences)
- Context files (CLAUDE.md / AGENTS.md, loaded fresh each session)
- Explicit session forking (inherits full history)

### Context File Loading

Walks filesystem from CWD to root, collecting `AGENTS.md` (preferred) or `CLAUDE.md` at each level. Global context from `~/.pi/agent/AGENTS.md` or `~/.pi/agent/CLAUDE.md`. Deduplicated by path, CWD-level files take precedence.

## Error Handling & Recovery

- **Tool errors**: Non-zero exit codes become Error objects. Full output (truncated) included in error message. LLM sees the error and can adapt.
- **Extension errors**: Caught and emitted to `ExtensionErrorListener`. Never crash the agent. Stack traces logged but don't propagate.
- **LLM errors**: Classified as retryable (overloaded, rate limit, 5xx, timeout) or non-retryable (context overflow, auth). Retryable errors get exponential backoff. Context overflow triggers compaction + single retry.
- **Abort handling**: User Ctrl+C kills process trees for bash, aborts LLM stream. Agent enters idle state cleanly.

## Security & Sandboxing

### Isolation Model: None

The agent executes with the user's full system permissions. There is **no sandbox** for bash execution:
- Commands run via `spawn()` with inherited environment and detached process groups
- No command filtering, whitelisting, or validation
- No confirmation dialogs for destructive operations (`rm -rf`, `git push --force`, etc.)

### Permission System: Extension Hooks Only

The only approval mechanism is the `tool_call` extension event, which can return `{ block: true, reason: "..." }`. Without a blocking extension loaded, all tool calls execute unconditionally.

The `user_bash` event similarly allows extensions to intercept user `!` commands.

### Extension Security

Extensions execute arbitrary TypeScript/JavaScript via `jiti` (dynamic module loader). No code review, signature verification, or capability restrictions. Extensions can:
- Access the full filesystem
- Execute shell commands
- Intercept and modify all agent communication
- Register tools with arbitrary execute handlers

### Auth Storage

API keys stored as **plaintext JSON** at `~/.pi/auth.json` with file mode `0o600`. OAuth tokens include expiry and auto-refresh with file locking. No encryption beyond OS-level filesystem permissions.

## Extensibility

The extension system is the agent's most sophisticated feature. Extensions are TypeScript modules exporting a factory function:

```typescript
export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
        if (event.tool === "bash" && event.input.command.includes("rm -rf")) {
            return { block: true, reason: "Destructive command blocked" };
        }
    });
    
    pi.registerTool({ name: "my-tool", ... });
    pi.registerCommand("my-cmd", { handler: async (args, ctx) => { ... } });
    pi.registerShortcut(Key.ctrlShift("u"), { handler: async (ctx) => { ... } });
    pi.registerProvider("my-llm", { models: [...], streamSimple: ... });
}
```

### Extension Capabilities

| Capability | API | What It Enables |
|-----------|-----|-----------------|
| Event subscription | `pi.on(event, handler)` | 19+ lifecycle events with interception/mutation |
| Tool registration | `pi.registerTool(def)` | Custom tools with TypeBox schemas and rendering |
| Command registration | `pi.registerCommand(name, opts)` | Slash commands with autocomplete |
| Keyboard shortcuts | `pi.registerShortcut(key, opts)` | Interactive mode hotkeys |
| CLI flags | `pi.registerFlag(name, opts)` | Boolean/string flags accessible at runtime |
| Provider registration | `pi.registerProvider(name, config)` | Custom LLM providers with OAuth and streaming |
| Message injection | `pi.sendMessage(text, opts)` | Steer, follow-up, or next-turn delivery |
| Session state | `pi.appendEntry(data)` | Persist custom data in session tree |
| UI rendering | `ctx.ui.custom(factory)` | TUI components (interactive mode) |
| Inter-extension comms | `pi.events` | Shared EventBus for extension-to-extension messaging |

### RPC Protocol

For IDE integration, the agent runs in RPC mode (`pi --rpc`), communicating via JSON Lines on stdin/stdout. The protocol supports:
- Prompting, steering, follow-up, abort
- Model/thinking-level control
- Session management (fork, clone, switch, export)
- Bash execution
- Extension UI requests (select, confirm, input, editor, notify, widgets)

### Package Manager

Users can install extensions, skills, prompts, and themes from:
- **NPM**: `pi install npm:@foo/bar`
- **Git**: `pi install git:github.com/user/repo`
- **Local**: `pi install ./path/to/extension`

Packages are resolved into resource paths and persisted in settings.json. Scoped to global (`~/.pi/agent/`) or project (`.pi/`).

### Skills System

Skills are markdown files with YAML frontmatter, discovered from `~/.pi/agent/skills/` and `.pi/skills/`. They're presented to the LLM in the system prompt as an XML block with name, description, and file path. The LLM reads the skill file when it decides the task matches.

## Dependencies & Tech Stack

| Package | Role |
|---------|------|
| `@mariozechner/pi-ai` | LLM provider abstraction (Anthropic, OpenAI, Google, Mistral, etc.) |
| `@mariozechner/pi-agent-core` | Agent loop, state machine, tool dispatch |
| `@mariozechner/pi-tui` | Terminal UI with differential rendering |
| `@mariozechner/jiti` | Dynamic TypeScript module loading for extensions |
| `@sinclair/typebox` | JSON schema builder for tool parameters |
| `ajv` | JSON schema validation |
| `diff` | Unified diff generation for edit tool |
| `marked` | Markdown rendering |
| `chalk` | Terminal colors |
| `cli-highlight` | Code syntax highlighting |
| `glob` / `minimatch` / `ignore` | File pattern matching with .gitignore support |
| `proper-lockfile` | File locking for concurrent access |
| `undici` | HTTP client with proxy support |
| `@silvia-odwyer/photon-node` | WASM-based image processing |

Build: `tsgo` (TypeScript compiler), `vitest` for testing (30+ test files), optional Bun compilation for standalone binary.

## Strengths

- **Deeply extensible**: The 19+ event hook system with mutation/blocking capabilities is more powerful than most coding agent extension APIs. Extensions can add providers, tools, commands, UI, and intercept virtually everything.
- **Multi-modal interface**: Same AgentSession powers interactive TUI, headless RPC (for IDEs), print mode (for scripting), and embeddable SDK — all with identical capabilities.
- **Session tree with branching**: Append-only JSONL with tree structure allows non-destructive exploration. Branch summarization preserves context when switching paths.
- **Thoughtful compaction**: Structured summarization prompts (goal/progress/decisions/next-steps), file operation tracking across compactions, and split-turn handling show attention to context quality.
- **Rich TUI**: 30+ custom components, theme system, syntax highlighting, image rendering, keyboard shortcuts. The interactive experience is polished.
- **Custom LLM providers**: Full OAuth PKCE flow, custom streaming, header injection — extensions can add any provider without touching core code.
- **SDK with progressive control**: From zero-config `createAgentSession()` to full control with replaced resource loaders, the SDK scales from simple to complex use cases.

## Limitations

- **No sandbox**: Bash commands execute with full system permissions. A malicious or confused LLM can destroy the filesystem. The only mitigation is extension-based blocking, which requires the user to set it up.
- **No built-in approval system**: Unlike Claude Code's permission system, there's no default confirmation for dangerous operations. All approval is extension-dependent.
- **No cross-session memory**: Sessions are fully isolated. There's no mechanism for the agent to learn from past sessions or remember user preferences beyond settings.json and context files.
- **Simplistic token counting**: `chars / 4` heuristic can be significantly off for non-English text, code-heavy content, or special tokens. No actual tokenizer is used.
- **No planning capability**: Pure ReAct with no plan-then-execute option. For complex multi-step tasks, the agent relies entirely on the LLM's ability to maintain coherence across turns.
- **Extension security**: Extensions run with full process permissions, loaded via dynamic import with no verification. A malicious package could exfiltrate data or compromise the system.
- **Plaintext API key storage**: Keys stored unencrypted in `~/.pi/auth.json`, relying solely on file permissions.
- **No rate limiting for tools**: Individual tools can be called unlimited times per second with no throttling.
- **Heavy codebase**: ~43K lines of TypeScript across 150+ files. The extension API alone is 1500 lines of type definitions. This is a significant maintenance burden and onboarding cost.

## Key Takeaways for Our Agent

- **Shared session core across interfaces is a strong pattern.** Pi's `AgentSession` proving identical behavior across TUI, RPC, print, and SDK modes means features only need to be built once. We should design our agent loop as interface-agnostic from the start.

- **Extension hooks at every lifecycle point are powerful but need guardrails.** Pi's 19+ events with mutation/blocking give extensions enormous power, but without a capability system, any extension can do anything. We should consider capability-based permissions for extensions.

- **Compaction quality matters more than compaction trigger.** Pi's structured summarization prompts (with goal/progress/decisions/next-steps format) and file operation tracking produce much better summaries than naive truncation. We should invest in compaction prompt engineering early.

- **The lack of a built-in permission system is a real gap.** Claude Code's approach of requiring user approval for tool calls (with configurable allowlists) is safer than Pi's "everything allowed unless an extension blocks it" model. We should build approval into the core, not delegate it to extensions.

- **Session branching with summarization is underrated.** Being able to explore a path, abandon it, and have the context of what was tried carried forward is genuinely useful for complex tasks. Worth implementing from the start rather than retrofitting.
