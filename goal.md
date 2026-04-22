# Goal

A modular, SDK-first coding agent that's clean enough to embed in other systems (household AI, automations, IDE integrations) and polished enough to use daily as a TUI. Draws from the best ideas in Pi, OpenCode, and Claude Code while staying lean.

## Design Principles

**SDK-first, TUI-second.** The core is a library with a clean programmatic API. The TUI is one consumer of that API, not the center of the architecture. Other consumers: a household AI agent, headless CI workflows, an RPC server for IDE integration.

**Plugin-oriented extensibility.** Follow OpenCode's hook-based plugin model rather than Pi's monolithic extension API. Plugins are npm packages or local files that export a factory function. Hooks are typed input/output pairs at well-defined points. Plugins can register tools, modify LLM parameters, intercept tool calls, and provide auth — but they do it through narrow, composable hooks, not a god-object API.

**Permission-aware by default.** Claude Code's permission model is the gold standard here. Tools require approval unless explicitly allowlisted. Allowlists are scoped (global, project, session). Dangerous operations (rm -rf, force push, etc.) get extra scrutiny. This is a core feature, not a plugin concern.

**Persistent memory across sessions.** Sessions are isolated conversations, but the agent accumulates knowledge over time: user preferences, project context, past decisions. Memory is file-based, human-readable, and editable.

**Structured compaction over naive truncation.** When context gets long, summarize with purpose. Track file operations across compactions. Use structured prompts (goal, progress, decisions, next steps) so the LLM can pick up where it left off.

**Small surface area.** Resist the urge to build everything. A well-designed tool system and plugin hooks mean most features are additive, not architectural. The core should be < 5K lines.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                       Consumers                          │
│  ┌─────┐  ┌──────────┐  ┌─────────┐  ┌──────────────┐ │
│  │ TUI │  │ RPC/HTTP │  │Headless/ │  │ Household AI │ │
│  │     │  │ (IDE)    │  │   CI     │  │    Agent     │ │
│  └──┬──┘  └────┬─────┘  └────┬────┘  └──────┬───────┘ │
│     └───────────┼─────────────┼──────────────┘         │
│           ┌─────┴──────┐                                │
│           │   Session   │  ← one per conversation       │
│           └─────┬──────┘                                │
│     ┌───────────┼───────────────┐                       │
│  ┌──┴───┐  ┌────┴────┐  ┌──────┴──────┐               │
│  │Agent │  │ Memory  │  │  Permissions │               │
│  │ Loop │  │  Store  │  │   System     │               │
│  └──┬───┘  └─────────┘  └─────────────┘               │
│     │                                                    │
│  ┌──┴──────────────────────────────┐                    │
│  │          Plugin Host            │                    │
│  │  hooks · tools · providers      │                    │
│  └──┬──────────────────────────────┘                    │
│     │                                                    │
│  ┌──┴──────────────────────────────┐                    │
│  │         LLM Provider            │                    │
│  │   (Vercel AI SDK, OpenAI-compat)│                    │
│  └─────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

### Core Modules

**Session** — one per conversation. Owns the message history, model selection, and turn lifecycle. Persisted as append-only JSONL with tree structure (like Pi) for branching. Consumers create sessions via the SDK and subscribe to events.

**Agent Loop** — ReAct-style (observe → think → act → observe). The LLM decides each action. Supports steering (mid-turn user interruption) and follow-up message queuing. Configurable thinking levels for models that support extended reasoning.

**Plugin Host** — loads and manages plugins. Dispatches typed hooks at key lifecycle points. Plugins are npm packages or local `.ts`/`.js` files. The host is the only way to extend the agent — no subclassing, no monkey-patching.

**Permission System** — built into the core, not a plugin. Rule-based: each tool operation is `allow`, `ask`, or `deny`. Rules scoped to global (`~/.agent/`), project (`.agent/`), or session. Pattern matching for file paths and command patterns. The TUI (or any consumer) implements the "ask" UI; the core just emits the question.

**Memory Store** — persistent, file-based, human-readable. Markdown files with YAML frontmatter, indexed by a manifest. Types: user preferences, project context, feedback/corrections, references to external systems. Loaded at session start, written when the agent learns something worth keeping. Survives across sessions.

**LLM Provider** — Vercel AI SDK for provider abstraction. OpenAI-compatible APIs as the baseline, so any provider works out of the box. Provider-specific features (Anthropic thinking, caching) supported via AI SDK's provider extensions. Plugins can register custom providers.

## Plugin System

### Design: Typed Hooks, Not a God Object

Inspired by OpenCode's hook-based plugin model. A plugin is a function that receives context and returns hooks. Hooks are narrow, typed interception points — not a monolithic API surface like Pi's `ExtensionAPI`. Each hook receives structured input and returns a typed action/result.

The hook surface is designed so that an external orchestrator like Legato (which tracks agent activity via lifecycle events) can integrate purely through hooks — no special API needed.

```typescript
type Plugin = (ctx: PluginContext) => Promise<PluginHooks>

interface PluginContext {
  cwd: string
  config: AgentConfig
  session: ReadonlySession
  memory: ReadonlyMemoryStore
  exec: (cmd: string, opts?: ExecOpts) => Promise<ExecResult>
  env: Record<string, string>   // injected env vars (e.g. LEGATO_TASK_ID)
  log: PluginLogger              // structured logging scoped to plugin
}
```

### Complete Hook Reference

Every hook listed below, what fires it, what the plugin receives, and what it can return. Grouped by lifecycle phase.

#### Session Lifecycle

| Hook | Fires When | Input | Output | Notes |
|------|-----------|-------|--------|-------|
| `session.start` | Session begins or resumes | `{ reason: "new" \| "resume" \| "fork" \| "compact", sessionId }` | `void` | Legato uses this to set activity state |
| `session.end` | Session terminates | `{ reason: "user_exit" \| "abort" \| "error" \| "idle", sessionId }` | `void` | Legato clears activity state here |
| `config.change` | Config file changes mid-session | `{ source: "global" \| "project" \| "local", path, changes }` | `void` | |
| `cwd.change` | Working directory changes | `{ previous, current }` | `void` | |

#### Per-Turn Hooks

| Hook | Fires When | Input | Output | Notes |
|------|-----------|-------|--------|-------|
| `turn.start` | User prompt submitted, before LLM call | `{ prompt, images?, turnIndex }` | `{ prompt?, systemMessage?, abort? }` | Can rewrite prompt or inject system context. Legato sets "working" here |
| `turn.end` | Agent finishes responding (no more tool calls) | `{ messages, toolCalls, turnIndex }` | `{ followUp?, systemMessage? }` | Can inject follow-up. Legato sets "waiting" here |
| `turn.error` | Turn ends due to LLM error | `{ error, errorType: "rate_limit" \| "auth" \| "server" \| "overflow" \| "unknown" }` | `{ retry? }` | Plugin can request retry |

#### Tool Execution

| Hook | Fires When | Input | Output | Notes |
|------|-----------|-------|--------|-------|
| `tool.before` | Before tool executes (after permission check) | `{ tool, args, toolCallId }` | `{ action: "proceed" \| "block" \| "modify", args?, reason?, context? }` | Can block, modify args, or inject context for LLM. Runs AFTER permission system |
| `tool.after` | After tool succeeds | `{ tool, args, result, toolCallId }` | `{ result?, context? }` | Can modify result or add context |
| `tool.error` | After tool fails | `{ tool, args, error, toolCallId }` | `{ result?, retry? }` | Can provide fallback result or request retry |

#### Permission Hooks

| Hook | Fires When | Input | Output | Notes |
|------|-----------|-------|--------|-------|
| `permission.request` | Permission system resolved to "ask" | `{ tool, args, category, pattern }` | `void` | Notification only — plugins cannot override "ask" decisions. Use for activity tracking (Legato) |
| `permission.granted` | User approved a permission request | `{ tool, args, category, persist: boolean }` | `void` | |
| `permission.denied` | User or rule denied a tool call | `{ tool, args, category, reason }` | `void` | |

#### LLM Interaction

| Hook | Fires When | Input | Output | Notes |
|------|-----------|-------|--------|-------|
| `chat.params` | Before LLM API call | `{ model, temperature, maxTokens, tools, thinkingLevel }` | Partial override of input fields | Can change model, temperature, etc. per-request |
| `chat.headers` | Before LLM API call | `{ headers, provider, model }` | `{ headers }` | Inject auth headers, routing headers |
| `chat.response` | After LLM response received | `{ status, headers, usage }` | `void` | Observational — for logging, cost tracking |

#### Context & Compaction

| Hook | Fires When | Input | Output | Notes |
|------|-----------|-------|--------|-------|
| `context.transform` | Before messages sent to LLM | `{ messages }` | `{ messages }` | Can filter, inject, reorder messages |
| `context.compact.before` | Before compaction runs | `{ messages, reason: "threshold" \| "overflow" \| "manual" }` | `{ instructions?, replace? }` | Can customize compaction prompt or provide replacement summary |
| `context.compact.after` | After compaction completes | `{ summary, tokensBefore, tokensAfter }` | `void` | |

#### Subagent Hooks

| Hook | Fires When | Input | Output | Notes |
|------|-----------|-------|--------|-------|
| `subagent.start` | Subagent spawned | `{ agentType, agentId, prompt }` | `void` | |
| `subagent.end` | Subagent finishes | `{ agentType, agentId, result }` | `void` | |

#### Branch & Tree Navigation

| Hook | Fires When | Input | Output | Notes |
|------|-----------|-------|--------|-------|
| `branch.before` | Before navigating to a different branch | `{ targetId, oldLeafId, summarize }` | `{ cancel?, summary?, instructions? }` | Can provide custom branch summary or cancel |
| `branch.after` | After branch navigation completes | `{ targetId, oldLeafId, summary? }` | `void` | |

#### File & Workspace

| Hook | Fires When | Input | Output | Notes |
|------|-----------|-------|--------|-------|
| `file.changed` | Watched file changes on disk | `{ path, changeType: "created" \| "modified" \| "deleted" }` | `{ systemMessage? }` | Can inject context about the change |
| `worktree.create` | Git worktree created for subagent | `{ path, branch }` | `void` | |
| `worktree.remove` | Git worktree cleaned up | `{ path, branch }` | `void` | |

#### Registration Hooks (called once at plugin load)

| Hook | Fires When | Input | Output | Notes |
|------|-----------|-------|--------|-------|
| `tools` | Plugin loads | — | `Record<string, ToolDefinition>` | Register custom tools |
| `providers` | Plugin loads | — | `Record<string, ProviderDefinition>` | Register custom LLM providers |
| `commands` | Plugin loads | — | `Record<string, CommandDefinition>` | Register slash commands |

### Hook Execution Semantics

**Execution order**: Hooks from all plugins fire in declaration order (config array order). Not parallel — sequential and deterministic. This differs from Claude Code (parallel) but matches OpenCode and avoids merge-conflict complexity.

**Multiple plugins returning actions**: For hooks that return actions (`tool.before`, `context.transform`, etc.):
- Actions are applied sequentially — each plugin sees the output of the previous
- `block` short-circuits — no further plugins are called
- For `modify`, the modified value is passed to the next plugin
- The permission system runs BEFORE `tool.before` — plugins cannot override a `deny` rule

**Error isolation**: If a plugin hook throws, the error is logged and the hook is skipped. Plugins never crash the agent.

**Async with timeout**: All hooks have a configurable timeout (default 10s). Hooks that exceed the timeout are killed and skipped.

### Plugin Types

```typescript
interface PluginHooks {
  // === Session lifecycle ===
  "session.start"?: (input: SessionStartInput) => Promise<void>
  "session.end"?: (input: SessionEndInput) => Promise<void>
  "config.change"?: (input: ConfigChangeInput) => Promise<void>
  "cwd.change"?: (input: CwdChangeInput) => Promise<void>

  // === Per-turn ===
  "turn.start"?: (input: TurnStartInput) => Promise<TurnStartAction>
  "turn.end"?: (input: TurnEndInput) => Promise<TurnEndAction>
  "turn.error"?: (input: TurnErrorInput) => Promise<TurnErrorAction>

  // === Tool execution ===
  "tool.before"?: (input: ToolBeforeInput) => Promise<ToolBeforeAction>
  "tool.after"?: (input: ToolAfterInput) => Promise<ToolAfterAction>
  "tool.error"?: (input: ToolErrorInput) => Promise<ToolErrorAction>

  // === Permissions (observational) ===
  "permission.request"?: (input: PermissionRequestInput) => Promise<void>
  "permission.granted"?: (input: PermissionGrantedInput) => Promise<void>
  "permission.denied"?: (input: PermissionDeniedInput) => Promise<void>

  // === LLM interaction ===
  "chat.params"?: (input: ChatParamsInput) => Promise<Partial<ChatParamsInput>>
  "chat.headers"?: (input: ChatHeadersInput) => Promise<ChatHeadersOutput>
  "chat.response"?: (input: ChatResponseInput) => Promise<void>

  // === Context & compaction ===
  "context.transform"?: (input: ContextTransformInput) => Promise<ContextTransformOutput>
  "context.compact.before"?: (input: CompactBeforeInput) => Promise<CompactBeforeAction>
  "context.compact.after"?: (input: CompactAfterInput) => Promise<void>

  // === Subagents ===
  "subagent.start"?: (input: SubagentStartInput) => Promise<void>
  "subagent.end"?: (input: SubagentEndInput) => Promise<void>

  // === Branch navigation ===
  "branch.before"?: (input: BranchBeforeInput) => Promise<BranchBeforeAction>
  "branch.after"?: (input: BranchAfterInput) => Promise<void>

  // === File & workspace ===
  "file.changed"?: (input: FileChangedInput) => Promise<FileChangedAction>
  "worktree.create"?: (input: WorktreeInput) => Promise<void>
  "worktree.remove"?: (input: WorktreeInput) => Promise<void>

  // === Registration (static, called once) ===
  tools?: Record<string, ToolDefinition>
  providers?: Record<string, ProviderDefinition>
  commands?: Record<string, CommandDefinition>
}
```

### Plugin Loading

1. Declared in config: `plugins: ["@scope/plugin", "./local-plugin.ts"]`
2. npm plugins resolved and installed to `.agent/plugins/`
3. Local plugins loaded via dynamic import (jiti or native)
4. Plugin factory called with `PluginContext` — returns `PluginHooks`
5. Hooks from all plugins merged in declaration order
6. Plugins can declare compatibility via `engines.agent` in package.json

### Example: Legato Integration Plugin

This is the minimum viable plugin for Legato to track agent activity:

```typescript
import type { Plugin } from "@our-agent/plugin"

const legato: Plugin = async (ctx) => {
  const taskId = ctx.env.LEGATO_TASK_ID
  if (!taskId) return {}

  const setState = (activity: string) =>
    ctx.exec(`legato agent state ${taskId} --activity ${activity}`)

  return {
    "turn.start": async () => { await setState("working") },
    "tool.after": async () => { await setState("working") },
    "turn.end": async () => { await setState("waiting") },
    "permission.request": async () => { await setState("waiting") },
    "session.end": async () => { await setState("") },
  }
}

export default legato
```

### Example: Custom Auth Provider Plugin

```typescript
const gitlab: Plugin = async (ctx) => ({
  "chat.headers": async ({ headers, provider }) => {
    if (provider !== "gitlab") return { headers }
    const token = process.env.GITLAB_TOKEN
    return { headers: { ...headers, "PRIVATE-TOKEN": token } }
  },
  providers: {
    gitlab: {
      name: "GitLab Duo",
      baseUrl: "https://gitlab.com/api/v4/ai",
      models: [{ id: "claude-sonnet", name: "Claude Sonnet via GitLab" }],
    },
  },
})
```

### Example: Dangerous Command Blocker Plugin

```typescript
const safety: Plugin = async () => ({
  "tool.before": async ({ tool, args }) => {
    if (tool !== "bash") return { action: "proceed" }
    const cmd = args.command as string
    const dangerous = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=.*of=\/dev/]
    if (dangerous.some((p) => p.test(cmd))) {
      return { action: "block", reason: "Blocked by safety plugin: destructive system command" }
    }
    return { action: "proceed" }
  },
})
```

### What Plugins Can Do

- Register custom tools (web search, database queries, deployment, etc.)
- Register custom LLM providers and auth flows
- Register slash commands
- Modify LLM parameters per-request (temperature, model overrides)
- Inject custom headers (auth, routing)
- Intercept tool calls (block, modify args, inject context for LLM)
- Modify tool results (filter sensitive output, add context)
- Transform context before LLM calls (inject project knowledge, filter noise)
- Customize or replace compaction behavior
- React to session, turn, permission, branch, file, and subagent events
- Execute shell commands via `ctx.exec()`
- Track activity state for external orchestrators (Legato)

### What Plugins Cannot Do

- Override the permission system — `tool.before` runs AFTER permissions; a `deny` rule always wins
- Access other plugins' state — plugins are isolated; communicate via the agent's event stream
- Modify the core agent loop — can't change the ReAct cycle, only hook around it
- Render UI — plugins are headless; UI is the consumer's responsibility
- Block observational hooks (`permission.request`, `chat.response`, etc.) — they're fire-and-forget

### Comparison: Where Our Hooks Come From

| Our Hook | Claude Code Equivalent | OpenCode Equivalent | Pi Equivalent |
|----------|----------------------|--------------------|--------------| 
| `session.start` | `SessionStart` | — | `session_start` event |
| `session.end` | `SessionEnd` | — | `session_shutdown` event |
| `turn.start` | `UserPromptSubmit` | — | `before_agent_start` event |
| `turn.end` | `Stop` | — | `agent_end` event |
| `turn.error` | `StopFailure` | — | — |
| `tool.before` | `PreToolUse` | `tool.execute.before` | `tool_call` event (can block) |
| `tool.after` | `PostToolUse` | `tool.execute.after` | `tool_result` event (can modify) |
| `tool.error` | `PostToolUseFailure` | — | — |
| `permission.request` | `PermissionRequest` | `permission.ask` | — (no built-in permissions) |
| `permission.denied` | `PermissionDenied` | — | — |
| `chat.params` | — | `chat.params` | — |
| `chat.headers` | — | `chat.headers` | `before_provider_request` event |
| `chat.response` | — | — | `after_provider_response` event |
| `context.transform` | — | `experimental.chat.messages.transform` | `context` event |
| `context.compact.before` | `PreCompact` | `experimental.session.compacting` | `session_before_compact` event |
| `context.compact.after` | `PostCompact` | — | `session_compact` event |
| `subagent.start` | `SubagentStart` | — | — |
| `subagent.end` | `SubagentStop` | — | — |
| `branch.before` | — | — | `session_before_tree` event |
| `branch.after` | — | — | `session_tree` event |
| `file.changed` | `FileChanged` | — | — |
| `worktree.create` | `WorktreeCreate` | — | — |
| `config.change` | `ConfigChange` | `config` | — |
| `cwd.change` | `CwdChanged` | — | — |
| `tools` (register) | — | `tool` (in hooks) | `registerTool()` |
| `providers` (register) | — | `provider` (in hooks) | `registerProvider()` |
| `commands` (register) | — | — | `registerCommand()` |

### Hooks NOT Adopted (and Why)

| Omitted Hook | Source | Reason |
|--------------|--------|--------|
| `Notification` | Claude Code | Consumer concern, not plugin concern. TUI handles its own notifications |
| `Elicitation` / `ElicitationResult` | Claude Code | MCP-specific. If we add MCP, we add this hook |
| `InstructionsLoaded` | Claude Code | Internal detail. Plugins use `context.transform` instead |
| `UserPromptExpansion` | Claude Code | Slash commands are registered via `commands`, not intercepted |
| `TeammateIdle` | Claude Code | Multi-agent orchestration lives outside the plugin system |
| `shell.env` | OpenCode | Use `ctx.env` in plugin context instead |
| `model_select` | Pi | Use `chat.params` to observe/override model selection |
| `input` (transform user input) | Pi | Use `turn.start` which can rewrite the prompt |
| `registerShortcut` / `registerFlag` | Pi | UI concerns. TUI consumer handles its own keybindings |
| Pi's `event` (generic event bus) | Pi / OpenCode | Too broad. Each hook is typed and specific |

## Tool System

### Built-in Tools

| Tool | Purpose |
|------|---------|
| `bash` | Shell command execution with timeout, abort, output truncation |
| `read` | File reading with offset/limit, image support |
| `write` | File creation/overwrite with auto-mkdir |
| `edit` | Targeted text replacement with fuzzy matching |
| `grep` | Pattern search (ripgrep backend) |
| `find` | File search (fd backend) |
| `ls` | Directory listing |

### Tool Definition

Tools use Zod schemas for parameter validation:

```typescript
interface ToolDefinition {
  name: string
  description: string
  parameters: ZodSchema
  permission: PermissionCategory
  execute: (args: T, ctx: ToolContext) => Promise<ToolResult>
}
```

Every tool declares its permission category. The permission system checks before execution.

### Execution Model

- Tools can run sequentially or in parallel (per-tool configuration)
- Write operations to the same file are serialized (mutation queue)
- Bash spawns detached processes with process-tree cleanup on timeout/abort
- Output truncation: keep-head for read tools, keep-tail for bash (full output saved to temp file)

## Permission System

### Rule Structure

```typescript
interface PermissionRules {
  bash: RuleSet     // shell commands
  read: RuleSet     // file reading
  write: RuleSet    // file creation/modification
  edit: RuleSet     // file editing
  find: RuleSet     // file searching
  grep: RuleSet     // pattern searching
}

type RuleSet = "allow" | "ask" | "deny" | PatternRules
type PatternRules = Record<string, "allow" | "ask" | "deny">
```

### Scope Hierarchy

1. **Global** (`~/.agent/permissions.json`) — user-wide defaults
2. **Project** (`.agent/permissions.json`) — per-project overrides
3. **Session** — runtime grants (not persisted by default)

Project rules override global. Session grants are additive.

### Examples

```json
{
  "bash": {
    "*": "ask",
    "git status": "allow",
    "git diff*": "allow",
    "npm test": "allow",
    "rm -rf*": "deny"
  },
  "read": "allow",
  "write": {
    "*": "ask",
    "*.test.*": "allow"
  }
}
```

### Flow

1. Tool requests execution
2. Permission system evaluates rules (most specific pattern wins)
3. If `allow` → execute immediately
4. If `deny` → return error to LLM
5. If `ask` → emit permission request event; consumer (TUI, RPC client) presents UI; user approves or denies
6. Plugin `permission.check` hook runs before the consumer ask — plugins can auto-approve based on context

## Session & Context Management

### Session Persistence

Append-only JSONL with tree structure, following Pi's model:
- Each entry has `id` and `parentId` forming a DAG
- Entries are immutable — branching moves the leaf pointer
- Supports forking (new session file from a branch point)
- File location: `~/.agent/sessions/<project-hash>/<timestamp>_<id>.jsonl`

### Compaction

Structured compaction following Pi's approach, with improvements:

- **Trigger**: when `contextTokens > contextWindow - reserveTokens`
- **Summary format**: Goal / Constraints / Progress (Done, In Progress, Blocked) / Key Decisions / Next Steps / Critical Context
- **Iterative updates**: each compaction builds on the previous summary
- **File tracking**: read/modified files accumulated across compactions as XML tags
- **Split-turn handling**: separate prefix summary when cutting mid-turn
- **Plugin hook**: `session.compact` lets plugins customize or replace the compaction strategy

### Branch Summarization

When navigating away from a branch:
1. Collect entries from current position back to common ancestor with target
2. Generate structured summary via LLM
3. Inject summary as context in the new branch
4. The LLM knows what was tried and abandoned

## Memory System

### Design

Persistent, cross-session knowledge. Not conversation history — that's the session. Memory is what the agent _learns_ that's worth keeping.

### Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| `user` | Who the user is, their preferences, expertise | "Senior TS dev, prefers functional style" |
| `feedback` | Corrections and confirmed approaches | "Don't mock the DB in integration tests" |
| `project` | Ongoing work, deadlines, decisions | "Auth rewrite driven by compliance, not tech debt" |
| `reference` | Pointers to external systems | "Pipeline bugs tracked in Linear project INGEST" |

### Storage

```
~/.agent/memory/
├── MEMORY.md           # Index file — one-line entries, always loaded
├── user_role.md        # Individual memory files
├── feedback_testing.md
├── project_auth.md
└── reference_linear.md
```

Each file has YAML frontmatter (name, description, type) and markdown body. The index is always loaded into context; individual files are loaded when relevant.

### Rules

- Memory is for non-obvious knowledge, not things derivable from code or git history
- The agent verifies memories against current state before acting on them (memories can go stale)
- User can explicitly ask to remember or forget things
- Memory files are human-readable and editable

## Subagent System

For complex tasks, the main agent can spawn subagents:

- **Explore agent**: fast, read-only, for codebase research across many files
- **Worker agent**: full tool access, runs in an isolated git worktree
- **Review agent**: read-only, for code review against specific criteria

Subagents run in their own sessions with focused system prompts. Results are returned to the parent agent as tool results. Subagents inherit the parent's plugins and permissions but not its conversation history.

## Configuration

### File Locations

```
~/.agent/                    # Global
├── config.json              # Global settings
├── permissions.json         # Global permission rules
├── memory/                  # Persistent memory
├── plugins/                 # Installed plugins
└── sessions/                # Session storage

.agent/                      # Project-scoped
├── config.json              # Project settings (overrides global)
├── permissions.json         # Project permission rules
├── AGENT.md                 # Project context (like CLAUDE.md)
├── plugins/                 # Project-local plugins
└── skills/                  # Project-local skills
```

### Config Schema

```json
{
  "model": "anthropic/claude-sonnet-4-20250514",
  "plugins": ["@scope/plugin", "./local-plugin.ts"],
  "permissions": { "bash": "ask", "read": "allow" },
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "memory": { "enabled": true }
}
```

## Language & Stack Decision

**Strongly leaning TypeScript** for:
- Vercel AI SDK (first-class multi-provider support, streaming, tool calling)
- npm ecosystem for plugins
- Zod for schema validation
- Familiar territory

**Runtime**: Node.js (broadest compatibility) or Bun (faster, better TS support). Decision deferred.

**Key dependencies** (planned):
- `ai` (Vercel AI SDK) — LLM provider abstraction
- `zod` — schema validation for tools and config
- `ink` or `@anthropic-ai/claude-code` TUI primitives — terminal UI (TBD)
- `diff` — edit tool diff generation
- `glob` / `minimatch` — file patterns

## Non-Goals

- **IDE plugin**: the RPC interface is the IDE integration point. We don't build VS Code / JetBrains extensions.
- **Web UI**: headless consumers can build their own. We provide the SDK.
- **Multi-user / cloud**: this is a local-first, single-user tool.
- **Agent marketplace**: plugins are npm packages. npm is the marketplace.

## Open Questions

- [ ] Node.js vs Bun runtime
- [ ] TUI framework (Ink, blessed, custom, or something else)
- [ ] Session file format details (Pi's JSONL is good — adopt directly or modify?)
- [ ] Subagent isolation model (process-based, worker threads, or in-process?)
- [ ] Should the RPC protocol be JSON-RPC (like Pi) or HTTP/REST (like OpenCode)?
- [ ] How should the household AI agent consume the SDK? Long-running process with session reuse, or spawn-per-task?
