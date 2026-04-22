# Claude Code — Architecture Analysis

> Claude Code is Anthropic's official CLI agent for software engineering tasks. Built in TypeScript on the Bun runtime with a React/Ink terminal UI, it implements a streaming tool-use loop with ~40 built-in tools, multi-agent orchestration, persistent memory, automatic context compaction, and a sophisticated permission system. At ~512K lines across ~1,900 files, it is one of the most feature-rich coding agents in production.

## Overview

| Attribute | Detail |
|-----------|--------|
| Language | TypeScript (strict) |
| Runtime | Bun |
| Terminal UI | React + Ink |
| CLI Framework | Commander.js |
| LLM Provider | Anthropic (Claude) via `@anthropic-ai/sdk` |
| Schema Validation | Zod v4 |
| Protocols | MCP (Model Context Protocol), LSP |
| Telemetry | OpenTelemetry + gRPC |
| Feature Flags | GrowthBook |
| Auth | OAuth 2.0, JWT, macOS Keychain |
| Scale | ~1,900 files, 512K+ LoC |
| Source | Leaked via npm source map (March 2026) |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI Entry (cli.tsx)                      │
│  Commander.js parsing → fast-path checks → init() bootstrap     │
└─────────────┬───────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    React/Ink REPL (main.tsx)                     │
│  Terminal UI, input handling, keybindings, vim mode, voice       │
└─────────────┬───────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   QueryEngine (QueryEngine.ts)                   │
│  Session lifecycle, message state, system prompt assembly        │
│  Per-conversation; each submitMessage() = one turn               │
└─────────────┬───────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Query Loop (query.ts)                         │
│  while(true):                                                   │
│    1. snipCompact → microcompact → contextCollapse → autocompact│
│    2. callModel() streaming API call                            │
│    3. Stream tool_use blocks → toolOrchestration.ts             │
│    4. Permission check (useCanUseTool) → execute → yield result │
│    5. Stop hooks → decide: continue loop or terminal            │
└─────────────┬───────────────────────────────────────────────────┘
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
┌────────┐┌────────┐┌────────┐
│ Tools  ││Services││ Bridge │
│ (~40)  ││(API,   ││(IDE,   │
│        ││MCP,LSP)││remote) │
└────────┘└────────┘└────────┘
```

The core execution model is a **streaming tool-use loop** (a variant of ReAct). The agent calls the Claude API, streams the response, detects `tool_use` blocks as they arrive, and can begin executing tools *before the full response completes* (streaming tool execution). After all tools complete, results are appended as `tool_result` messages and the loop continues until the model stops emitting tool calls.

## Core Components

### Entry Points (`entrypoints/cli.tsx`, `entrypoints/init.ts`)

The CLI entry has multiple fast-paths for zero-import responses (`--version`, `--dump-system-prompt`). For the main path, it dynamically imports the initialization module which bootstraps configs, telemetry, OAuth, proxy settings, and graceful shutdown handlers — all with aggressive parallelization:

```typescript
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Fast-path: zero module loading
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`${MACRO.VERSION} (Claude Code)`);
    return;
  }
  // ... full init path
}
```

### QueryEngine (`QueryEngine.ts` — 1,295 lines)

Owns the conversation lifecycle. One instance per conversation. Each `submitMessage()` call starts a new turn, assembling the system prompt, user context (CLAUDE.md files, git status), and coordinator context. It manages:
- Message state across turns
- File state cache (for detecting file changes)
- Permission denial tracking for SDK reporting
- System prompt construction via `fetchSystemPromptParts()`
- Model selection (with user-specified model overrides)
- Thinking mode configuration (adaptive by default)

### Query Loop (`query.ts` — 1,729 lines)

The inner loop is an `AsyncGenerator` that yields stream events, messages, and tombstones. Each iteration:

1. **Context management pipeline**: snipCompact → microcompact → contextCollapse → autocompact (four distinct compaction strategies, each gated by feature flags)
2. **API call**: Streams messages from `callModel()` with full system prompt, user context, and tool schemas
3. **Streaming tool execution**: Tools can begin executing as their `tool_use` blocks arrive (before the full response completes)
4. **Error recovery**: Reactive compaction on prompt-too-long, max-output-tokens recovery (up to 3 retries), fallback model switching
5. **Stop hooks**: Post-response hooks that can inject additional messages and force the loop to continue

State is carried in a `State` struct that is destructured at the top of each iteration and reconstructed at continue sites.

### API Client (`services/api/claude.ts` — 3,419 lines)

The largest single file. Handles:
- Streaming message creation via the Anthropic SDK beta API
- Beta header management (prompt caching, context management, structured outputs, task budgets, effort levels)
- Tool schema serialization for the API
- Fast mode / effort level resolution
- Advisor model dual-query support
- Fallback model switching on errors
- Usage tracking and cost calculation

## LLM Integration

### API Integration

Claude Code uses the `@anthropic-ai/sdk` beta messages API exclusively. All API calls go through `claude.ts`, which wraps `Anthropic.beta.messages.stream()`. The integration uses numerous beta features:

```typescript
// Beta headers assembled per-request
const betas = getMergedBetas(model, {
  promptCaching: true,
  contextManagement: true,
  structuredOutputs: jsonSchema !== undefined,
  taskBudgets: taskBudget !== undefined,
  effort: modelSupportsEffort(model),
  // ... more conditional betas
})
```

### Prompt Construction

System prompts are built in `constants/prompts.ts` (53K) via a section-based system. Each section is independently cacheable:

```typescript
const dynamicSections = [
  systemPromptSection('session_guidance', () => getSessionSpecificGuidanceSection(...)),
  systemPromptSection('memory', () => loadMemoryPrompt()),
  systemPromptSection('env_info_simple', () => computeSimpleEnvInfo(...)),
  // ... 20+ sections
]
```

User context (CLAUDE.md files, date, git status) is prepended to user messages via `prependUserContext()`. System context (git status snapshot, cache breakers) is appended to the system prompt. Both are memoized per conversation.

### Token Management & Cost Tracking

Token usage is tracked in `bootstrap/state.ts` global counters, aggregated in `cost-tracker.ts`. The system tracks input, output, cache creation, and cache read tokens per-model. USD cost is calculated from per-model pricing tables. Context window sizes are model-aware with dynamic thresholds.

### Context Window Strategy

Claude Code employs a **four-layer compaction pipeline**, each triggered at different thresholds:

1. **Snip Compact** (`HISTORY_SNIP`): Removes old messages from the middle of the conversation, keeping the most recent trajectory
2. **Microcompact** (cached): Removes tool results from older messages that are no longer relevant, using cache-editing to avoid prompt cache breaks
3. **Context Collapse** (`CONTEXT_COLLAPSE`): Projects a collapsed view over the conversation, committing collapses as staged summaries
4. **Auto Compact**: Full LLM-based summarization when token count exceeds ~(context_window - 13K buffer). Uses a forked agent to generate the summary, replacing the conversation with a compact boundary message

The auto-compact threshold is model-specific: `getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS`, with a circuit breaker after 3 consecutive failures.

### Streaming

Responses are streamed via `AsyncGenerator` through the entire pipeline. The `query()` function yields `StreamEvent | Message | TombstoneMessage | ToolUseSummaryMessage` events that flow up to the UI layer. A `StreamingToolExecutor` allows tools to begin execution as their input JSON is fully parsed, before the model finishes generating the full response.

## Tool System

### Tool Inventory (~40 tools)

| Category | Tools |
|----------|-------|
| File Operations | `FileReadTool`, `FileWriteTool`, `FileEditTool`, `GlobTool`, `GrepTool`, `NotebookEditTool` |
| Shell | `BashTool`, `PowerShellTool`, `REPLTool` |
| Agent | `AgentTool`, `SendMessageTool`, `TeamCreateTool`, `TeamDeleteTool` |
| Task Management | `TaskCreateTool`, `TaskGetTool`, `TaskUpdateTool`, `TaskListTool`, `TaskStopTool`, `TaskOutputTool`, `TodoWriteTool` |
| Web | `WebFetchTool`, `WebSearchTool` |
| Planning | `EnterPlanModeTool`, `ExitPlanModeTool`, `EnterWorktreeTool`, `ExitWorktreeTool` |
| MCP | `MCPTool`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `McpAuthTool` |
| Config | `ConfigTool`, `SkillTool`, `ToolSearchTool`, `LSPTool` |
| Scheduling | `CronCreateTool`, `RemoteTriggerTool`, `SleepTool` |
| Synthetic | `SyntheticOutputTool`, `BriefTool` |

### Tool Definition Pattern

Tools are defined using `buildTool()` with a `ToolDef` that specifies:
- Name and user-facing display name
- Input schema (Zod v4, lazily evaluated via `lazySchema()`)
- `description()` function for permission prompts
- `isReadOnly()` for concurrency classification
- `validateInput()` for pre-execution validation
- `call()` — the execution handler (returns `ToolResultBlockParam`)
- `renderToolUseMessage/renderToolResultMessage` — React/Ink components for UI

```typescript
export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
  schema: lazySchema(() => z.object({
    command: z.string(),
    timeout: z.number().optional(),
    // ...
  })),
  async call(input, context) { /* ... */ },
  // ...
} satisfies ToolDef)
```

### Tool Dispatch & Orchestration

Tool execution flows through `services/tools/toolOrchestration.ts`. The dispatcher:

1. **Partitions** tool calls into concurrency-safe batches (read-only tools run in parallel, write tools run sequentially)
2. **Permission checks** each tool via `useCanUseTool()` before execution
3. **Executes** tools with a configurable concurrency limit (default 10)
4. **Context modifiers** — tools can modify the `ToolUseContext` (e.g., changing CWD after `cd`)

### Tool Hooks

Tool execution is wrapped by `services/tools/toolHooks.ts` (21.8K) which runs pre/post hooks. These include user-defined shell hooks from `settings.json` that fire on specific tool invocations. Hooks can modify inputs, block execution, or inject messages.

## Planning & Reasoning

### Core Pattern: Streaming ReAct Loop

The agent uses a **ReAct-style loop** (Reasoning + Acting) with streaming — NOT a plan-then-execute architecture. The LLM generates text (reasoning) and `tool_use` blocks (actions) in a single response. Tool results are fed back as the next user message. The loop continues until the model stops requesting tools.

**11 terminal exit reasons:**

| Reason | Trigger |
|--------|---------|
| `completed` | Model stops requesting tools (normal end) |
| `blocking_limit` | Token count exceeds blocking limit |
| `aborted_streaming` | User interruption during model streaming |
| `aborted_tools` | User interruption during tool execution |
| `prompt_too_long` | 413 error, recovery exhausted |
| `max_turns` | Reached maxTurns limit |
| `stop_hook_prevented` | Stop hook prevented continuation |
| `token_budget_continuation` | Token budget system completion |
| `model_error` / `image_error` / `hook_stopped` | Error terminals |

**7 continue transitions** (loop continues instead of returning): `next_turn` (normal), `collapse_drain_retry`, `reactive_compact_retry`, `max_output_tokens_escalate`, `max_output_tokens_recovery` (up to 3x), `stop_hook_blocking`, `token_budget_continuation`.

### Token Budget System

A continuation system (`query/tokenBudget.ts`) that nudges the model to keep working:
- Tracks output tokens against a budget
- If below 90% threshold and not diminishing, injects a "keep going" meta-message
- Detects diminishing returns (<500 tokens delta for 3+ consecutive checks) and stops early

### Plan Mode

An explicit planning mode toggled via `EnterPlanModeTool`/`ExitPlanModeTool`. Plan mode is a **permission layer**, not an architectural pattern — it restricts which tools the agent can use (read-only), encouraging planning before execution. On very large contexts (>200K tokens), the model may be switched. There is also an **Ultraplan** feature for more structured planning in remote sessions.

### Sub-Agent Architecture

The `AgentTool` spawns child agents by **recursively calling `query()`** with isolated contexts. Sub-agents come in two flavors:

- **Sync agents**: Share parent's abort controller and AppState setter
- **Async agents**: Get independent abort controllers, set `isNonInteractiveSession: true`, can auto-background after 120 seconds

Each sub-agent gets its own `agentId`, `ToolUseContext`, file state cache, and MCP servers, with tools filtered by `resolveAgentTools()` based on agent type.

**Coordinator Mode** (`coordinator/coordinatorMode.ts`): Activated by `CLAUDE_CODE_COORDINATOR_MODE=1`. Injects a coordinator system prompt that teaches the LLM to orchestrate workers using `AgentTool` (spawn), `SendMessageTool` (continue), `TeamCreateTool`/`TeamDeleteTool` (manage). Workers are async agents running in parallel; the coordinator receives `<task-notification>` XML messages on completion.

**In-Process Teammates (Swarm)**: Uses `AsyncLocalStorage` for context isolation within the same Node.js process. Spawned via `spawnInProcessTeammate()`, tracked as `InProcessTeammateTaskState`.

Built-in agent types include: `general-purpose`, `Explore`, `review-consistency`, `review-correctness`, `review-tests-docs`, `Plan`, and others defined via markdown agent definition files.

### Task System

Seven task types with shared lifecycle (`pending` → `running` → `completed`/`failed`/`killed`):

| Task Type | Description |
|-----------|-------------|
| `local_agent` | AgentTool sub-agents |
| `local_bash` | Background shell commands |
| `remote_agent` | Remote agent sessions |
| `in_process_teammate` | In-process swarm teammates |
| `local_workflow` | Workflow tasks |
| `monitor_mcp` | MCP monitoring tasks |
| `dream` | Auto-dream background tasks |

Tasks support foreground/background modes, progress tracking, and can be managed via `TaskCreateTool`/`TaskUpdateTool`.

## Memory & Context Management

### Persistent Memory (`memdir/`)

The memory system uses a file-based approach (`memdir` = "memory directory"):
- `MEMORY.md` serves as the index file (max 200 lines, 25KB)
- Individual memory files use YAML frontmatter with name, description, and type fields
- Memory types: `user`, `feedback`, `project`, `reference`
- Memories are loaded into the system prompt via `loadMemoryPrompt()`
- Auto-memory extraction runs post-conversation to capture learnings
- Team memory synchronization is supported for shared contexts

### CLAUDE.md Integration

User instructions are loaded from CLAUDE.md files at multiple levels:
- `~/.claude/CLAUDE.md` (global user instructions)
- Project-level CLAUDE.md files (discovered via directory walk)
- Additional directories specified via `--add-dir`
- Content is injected as `claudeMd` user context, cached per conversation

### Conversation History

- Messages are stored in-memory in the `mutableMessages` array on `QueryEngine`
- Session persistence writes transcripts to disk for `/resume` functionality
- History includes a paste store for large pasted content (deduplicated by hash)
- File state cache tracks file contents to detect changes between reads

### Context Window Management

The four-layer compaction pipeline (described above) ensures the conversation stays within the model's context window. Key details:

- **Auto-compact threshold**: `contextWindow - 13,000 tokens` (buffer for output)
- **Warning threshold**: Additional 20K token buffer for UI warnings
- **Circuit breaker**: Max 3 consecutive auto-compact failures
- **Task budgets**: Server-side token budgets that survive compaction boundaries via client-side `remaining` tracking
- **Token estimation**: When exact counts aren't available, `tokenCountWithEstimation()` uses the last API response's usage data

## Error Handling & Recovery

### Custom Error Hierarchy

- `ClaudeError` — base application error
- `AbortError` — cancellation (handles SDK `APIUserAbortError`, DOM `AbortError`, and custom)
- `ShellError` — captures stdout, stderr, exit code, and interrupted flag
- `ConfigParseError` — includes file path and default fallback config
- `FallbackTriggeredError` — signals model fallback (e.g., Opus to Sonnet on repeated 529s)
- `TelemetrySafeError` — separate telemetry-safe message to prevent leaking paths/code

Tool errors are truncated to 10,000 chars (first/last 5,000), and Zod validation errors are formatted into LLM-friendly messages. Stack traces are trimmed to 5 frames for model context.

### Retry Logic (`services/api/withRetry.ts`)

- Default 10 max retries with exponential backoff (base 500ms)
- **529 (overloaded) selective retry**: Only foreground query sources retry (REPL, SDK, compact, agents). Background tasks (summaries, suggestions) bail immediately to avoid amplifying capacity cascades — each retry is 3-10x gateway amplification
- Max 3 retries on 529 before triggering model fallback
- **401/403 recovery**: Forces OAuth token refresh, clears API key cache, creates fresh client
- **ECONNRESET/EPIPE**: Disables HTTP keep-alive and reconnects
- **Fast mode fallback**: Short retry-after stays fast; long delays trigger cooldown to standard model
- **Persistent retry mode** (`CLAUDE_CODE_UNATTENDED_RETRY`): For unattended sessions, retries 429/529 indefinitely with 5-minute max backoff and 30-second heartbeat yields
- **Model context overflow**: Dynamically reduces `max_tokens` with 1,000-token safety buffer (floor of 3,000)

### Reactive Recovery

- **Prompt-too-long**: Reactive compaction attempts to compress context and retry
- **Max-output-tokens**: Up to 3 recovery attempts — first escalates to 64K output tokens, then injects "resume" meta-messages
- **Media size errors**: Reactive removal of oversized media and retry
- **Context collapse drain**: Commits staged collapses on a REAL API 413, then falls through to reactive compact
- **Fallback model**: On streaming failure, falls back to a secondary model

### Command Semantics

Non-zero exit codes are interpreted per command to prevent false error reporting: `grep`/`rg` exit 1 = "no matches found" (not error), `diff` exit 1 = "files differ", `find` exit 1 = "some dirs inaccessible".

### Withheld Error Messages

Recoverable errors (prompt-too-long, max-output-tokens, media-size) are withheld from SDK callers during recovery attempts. Either recovery subsystem's withhold is sufficient — they're independent, so turning one off doesn't break the other's recovery path.

## Security & Sandboxing

### Permission System (`hooks/useCanUseTool.tsx`, `hooks/toolPermission/`)

Every tool invocation passes through permission checking:

1. **Config-based rules**: Allowlists/denylists in `settings.json` at user, project, managed, and policy levels (priority: `flagSettings` > `policySettings` > project > local > user)
2. **Permission modes**: `default` (prompt for dangerous ops), `plan` (read-only), `acceptEdits` (auto-approve filesystem ops), `bypassPermissions` (skip all checks), `auto` (ML classifier-based, ant-only)
3. **Auto-mode classifier**: Classifies tool calls as safe/unsafe. Has a GrowthBook-backed circuit breaker that can disable auto mode globally if the classifier misbehaves
4. **Dangerous permission stripping**: When entering auto mode, strips broad allow rules for code-execution entry points (`python`, `node`, `bash`, `ssh`, `eval`, `exec`, `sudo`, `npm run`)
5. **Interactive approval**: Race-safe with `ResolveOnce` pattern — `claim()` atomically checks-and-marks resolution to close the async race window
6. **Bypass permissions killswitch**: Statsig gate that can force bypass mode off at startup

### Sandbox System (`utils/sandbox/sandbox-adapter.ts`)

Uses `@anthropic-ai/sandbox-runtime` for OS-level process isolation:

- **macOS**: Uses `seatbelt` (`sandbox-exec`) for filesystem and network restrictions
- **Linux/WSL2**: Uses `bubblewrap` (`bwrap`) for filesystem isolation, `socat` for network proxying, optional `seccomp` BPF filter for blocking unix domain sockets
- **Windows native / WSL1**: Unsupported

Key sandbox protections:
- Settings files always deny-write (prevents sandbox escape via config modification)
- `.claude/skills/`, `.claude/commands/`, `.claude/agents/` directories deny-write
- **Bare git repo attack prevention**: Blocks creation of `HEAD`, `objects`, `refs`, `hooks`, `config` in cwd; `scrubBareGitRepoFiles()` deletes them after each sandboxed command to prevent `core.fsmonitor` code execution
- Network domain allowlist/denylist with `allowManagedDomainsOnly` policy
- `sandbox.autoAllowBashIfSandboxed` auto-approves bash commands when sandboxed (default true)

### Bash Security Pipeline (`BashTool/bashSecurity.ts`)

The `bashCommandIsSafe` function runs a ~20-step validation pipeline:

1. Empty/incomplete command detection
2. Safe heredoc early-allow (strict pattern matching)
3. JQ `system()` function blocking
4. Obfuscated flag detection
5. Shell metacharacter analysis (after quote stripping)
6. Dangerous variable detection (`IFS` injection)
7. Command substitution blocking: `$()`, `${}`, `$[]`, `` `...` ``, `<()`, `>()`, `=()`; Zsh-specific: `~[`, `(e:`, `(+`, `always{}`, `=cmd`
8. Input/output redirection validation
9. `/proc/environ` access blocking
10. Backslash-escaped whitespace, brace expansion, control character, Unicode whitespace detection
11. Zsh dangerous command blocking: `zmodload`, `emulate`, `sysopen`/`sysread`/`syswrite`, `zpty`, `ztcp`, `zsocket`, `zf_*`
12. Comment-quote desync and quoted newline detection

**Subcommand safety cap**: `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50` — beyond this, falls back to `ask` to prevent CPU-starvation attacks.

**Path validation**: Dangerous removal path blocking for `rm`/`rmdir` targeting critical system directories. Per-command path extractors for 30+ commands with read/write/create classification.

**Destructive command warnings** (informational, not blocking): `git reset --hard`, `git push --force`, `git clean -f`, `rm -rf`, `DROP TABLE`, `kubectl delete`, `terraform destroy`, `--no-verify`.

### File Access Restrictions

- Protected files: `.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`, `.zshrc`, `.profile`, `.ripgreprc`, `.mcp.json`, `.claude.json`
- Protected directories: `.git`, `.vscode`, `.idea`, `.claude`
- Case-insensitive path normalization to prevent `.cLauDe/Settings.locaL.json` bypass on macOS/Windows
- Path traversal detection and UNC path vulnerability checking

### SSRF Guard for HTTP Hooks

DNS-lookup-level blocking of private/link-local/metadata addresses: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (cloud metadata), `100.64.0.0/10` (CGNAT), `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6. Intentionally **allows loopback** (`127.0.0.0/8`, `::1`) for local dev policy servers.

## Extensibility

### Plugin System (`plugins/`)

Three-tier plugin architecture:

1. **Marketplace plugins** (external, git-based): Installed from registries via `/plugin`. Identified by `name@marketplace`. Cloned locally with version pinning via commit SHA. Enterprise controls: `strictKnownMarketplaces`, `blockedMarketplaces`, `strictPluginOnlyCustomization`
2. **Built-in plugins**: Ship with the CLI, toggleable via `/plugin` UI. IDs use `{name}@builtin` format
3. **Bundled skills**: Compiled into the binary, always available, NOT toggleable

Plugins can provide commands, agents, skills, hooks, output-styles, MCP servers, and LSP servers.

### Skill System (`skills/`)

Skills are markdown files with YAML frontmatter (`SKILL.md`), loaded in priority order:

1. Managed (policy) → 2. User (`~/.claude/skills/`) → 3. Project (`.claude/skills/`) → 4. Additional dirs → 5. Legacy commands → 6. Bundled → 7. MCP skills → 8. Plugin skills

Key frontmatter fields: `name`, `description`, `when_to_use`, `allowed-tools`, `model`, `arguments`, `user-invocable`, `disable-model-invocation`, `hooks` (skill-scoped), `context` (`fork` for isolation), `agent`, `paths` (gitignore-style conditional activation), `effort`, `shell`.

**Dynamic skill discovery**: When files are read/written, the system walks parent directories looking for `.claude/skills/` directories. Skills with `paths:` frontmatter are stored dormant until a file operation touches a matching path. Special variables: `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`.

### MCP Integration (`services/mcp/`)

Extensive MCP server support at 116K lines in `client.ts`:

- **7 transport types**: `stdio`, `sse`, `http`, `ws`, `sdk`, `sse-ide`, `ws-ide`, `claudeai-proxy`
- **7 configuration scopes**: local (`.mcp.json`), user (`~/.claude.json`), project, dynamic, enterprise, claudeai (proxied), managed
- OAuth with XAA (cross-app access, SEP-990) for IdP-brokered auth
- Elicitation handling with `Elicitation`/`ElicitationResult` hooks
- MCP-to-skills bridge for exposing MCP server capabilities as skills
- Enterprise controls: `allowedMcpServers`, `deniedMcpServers`, `allowManagedMcpServersOnly`

### Hook System (27 Event Types, 4 Hook Types)

User-defined hooks in `settings.json` intercept operations across the entire lifecycle:

**Key hook events**: `PreToolUse` (exit 2 = block), `PostToolUse`, `PermissionRequest` (can auto-allow/deny), `UserPromptSubmit` (exit 2 = block), `Stop` (exit 2 = continue conversation), `PreCompact`/`PostCompact`, `SubagentStart`/`SubagentStop`, `SessionStart`/`SessionEnd`, `ConfigChange`, `InstructionsLoaded`, `WorktreeCreate`/`WorktreeRemove`, `CwdChanged`, `FileChanged`, `TaskCreated`/`TaskCompleted`, `TeammateIdle`, `Elicitation`/`ElicitationResult`, and more.

**4 hook types**:
1. **`command`** — Shell command with `if` filter (permission-rule-syntax, e.g., `"Bash(git *)"`)
2. **`prompt`** — LLM prompt evaluation with `$ARGUMENTS` placeholder
3. **`http`** — HTTP POST with SSRF guard, env-var interpolation in headers
4. **`agent`** — Sub-agent verifier that runs a prompt to validate conditions

**Hook sources** (merged at runtime): settings files, plugin hooks, skill hooks, registered callback hooks, session hooks.

**Security controls**: `disableAllHooks`, `allowManagedHooksOnly`, trust dialog requirement. ConfigChange hooks on policy settings cannot block them (results forced to `blocked: false`).

### Configuration System (5 Sources)

| Source | File Location | Priority |
|--------|--------------|----------|
| flagSettings | `--settings` CLI flag | Highest |
| policySettings | `<managed-path>/managed-settings.json` + drop-ins | High |
| projectSettings | `.claude/settings.json` | Medium |
| localSettings | `.claude/settings.local.json` (gitignored) | Medium |
| userSettings | `~/.claude/settings.json` | Lowest |

Key settings surface: `permissions` (allow/deny/ask rules), `hooks`, `model`/`availableModels`/`modelOverrides`, `enabledPlugins`, `sandbox`, `env`, `statusLine`, `outputStyle`, `language`, `attribution`, `agent`, `worktree`.

### CLAUDE.md / Instructions System

- **User**: `~/.claude/CLAUDE.md`
- **Project**: `./CLAUDE.md`
- **Local**: `./CLAUDE.local.md` (gitignored)
- **Managed**: `<managed-path>/CLAUDE.md`
- **Rules directories**: `~/.claude/rules/`, `.claude/rules/` with conditional activation via `paths:` frontmatter
- **`@include` directives**: CLAUDE.md files can include other files
- **`InstructionsLoaded` hook**: Fires with load reason metadata (session_start, nested_traversal, path_glob_match, include, compact)

### Command System (`commands.ts`, `commands/`)

~70+ slash commands registered via a central registry with feature-flagged conditional loading. Commands span: core (`/clear`, `/compact`, `/model`), session (`/resume`, `/share`, `/export`), configuration (`/config`, `/hooks`, `/mcp`, `/plugin`, `/skills`, `/permissions`, `/memory`), development (`/commit`, `/review`, `/diff`, `/pr_comments`), agents/tasks (`/tasks`, `/plan`, `/ultraplan`), IDE (`/ide`, `/desktop`), remote (`/teleport`), and diagnostics (`/doctor`, `/stats`, `/cost`).

### All User-Facing Customization Points

1. CLAUDE.md files (4 types) + rules directories
2. Skills directories with SKILL.md
3. Settings files (5 sources)
4. MCP servers (7 scopes)
5. Plugins (marketplace + built-in)
6. Hooks (27 events, 4 types)
7. Keybindings (`~/.claude/keybindings.json`)
8. Output styles (`.claude/output-styles/`)
9. Agent definitions (`.claude/agents/`)
10. Status line, file suggestion, spinner, attribution customization
11. Environment variables via settings `env` field

Enterprise lockdown: `strictPluginOnlyCustomization` restricts skills, agents, hooks, and MCP to approved plugins in approved marketplaces only.

## Dependencies & Tech Stack

| Dependency | Purpose |
|-----------|---------|
| `bun` | Runtime — fast startup, built-in bundler with DCE via `feature()` |
| `@anthropic-ai/sdk` | Anthropic API client with streaming support |
| `react` + `ink` | Terminal UI rendering (functional components, hooks) |
| `commander` | CLI argument parsing with extra-typings |
| `zod/v4` | Input validation for tool schemas and config |
| `@modelcontextprotocol/sdk` | MCP server connectivity |
| `@anthropic-ai/sandbox-runtime` | OS-level process sandboxing |
| `lodash-es` | Utility functions (memoize, uniqBy, etc.) |
| `chalk` | Terminal color output |
| `strip-ansi` | ANSI escape code stripping |
| `@opentelemetry/*` | Telemetry (lazy-loaded, ~400KB deferred) |
| `@grpc/grpc-js` | gRPC for telemetry export (~700KB, lazy-loaded) |

### Build System

Bun's bundler with dead-code elimination via `feature()` gates from `bun:bundle`. Feature flags like `PROACTIVE`, `KAIROS`, `BRIDGE_MODE`, `DAEMON`, `VOICE_MODE`, `AGENT_TRIGGERS`, `MONITOR_TOOL` control which code paths are included in builds. External builds strip internal-only features.

## Strengths

- **Streaming tool execution**: Tools begin running before the model finishes responding, significantly reducing latency on multi-tool turns
- **Four-layer compaction**: Sophisticated context window management with snip, microcompact (cache-editing), context collapse, and full LLM summarization — each layer operates on different granularity
- **Feature flag DCE**: `bun:bundle` feature gates enable complete dead-code elimination for internal vs external builds, keeping the public binary lean
- **Aggressive startup optimization**: Parallel prefetch of keychain, MDM settings, and API preconnect; lazy loading of heavy modules (OpenTelemetry, gRPC) until first use
- **Rich sub-agent architecture**: Full agent spawning with worktree isolation, background execution, progress tracking, and coordinator-mode swarms
- **Extensibility depth**: Four independent extension systems (plugins, skills, MCP, hooks) covering different customization needs
- **Permission granularity**: From full auto-approve to ML classifier-based approval to per-tool interactive prompts, with config at user/project/managed levels

## Limitations

- **Single-provider lock-in**: Exclusively uses the Anthropic API — no support for OpenAI, local models, or other providers
- **Massive codebase complexity**: At 512K+ lines with heavy feature-flag branching, the code is difficult to navigate; `claude.ts` alone is 3,419 lines with deeply nested conditionals
- **Circular dependency workarounds**: Multiple `require()` hacks and lazy imports to break circular dependencies (e.g., `getTeamCreateTool`, `getTeamDeleteTool`)
- **React in a CLI**: Using React/Ink for a terminal UI adds significant complexity and bundle size; the React compiler runtime is present throughout
- **Feature flag sprawl**: Many interacting feature flags (`HISTORY_SNIP`, `CONTEXT_COLLAPSE`, `CACHED_MICROCOMPACT`, `REACTIVE_COMPACT`) make it hard to reason about which compaction paths are active
- **No offline mode**: Requires API connectivity for all operations; no local model fallback
- **Leaked source**: The source was publicly exposed via npm source maps, which may have security implications for the internal build process

## Key Takeaways for Our Agent

- **Streaming tool execution is a major latency win**: Starting tool execution before the model finishes its full response (as `tool_use` blocks arrive) can save seconds per turn in multi-tool interactions. Claude Code's `StreamingToolExecutor` runs tools concurrently with model streaming. This is worth implementing early.

- **Multi-layer compaction beats single-strategy**: Rather than one compaction approach, Claude Code uses four complementary strategies at different granularities (surgical removal via snip, cache-editing via microcompact, staged collapse, full LLM summarization). Each handles a different failure mode. A single aggressive summarizer would lose too much context. The circuit breaker (max 3 consecutive failures) prevents infinite compaction loops.

- **Permission systems need multiple modes with a security pipeline**: A single "always prompt" approach is too slow for power users; "always allow" is too dangerous. The tiered approach (config allowlists → ML classifier → interactive prompt) with per-source settings is worth emulating. The 20-step bash security validation pipeline and SSRF guard for HTTP hooks show how deep command validation needs to go.

- **The tool definition pattern (schema + description + permission + handler + UI as a single unit) scales well to 40+ tools**: Having each tool as a self-contained module with consistent interfaces makes it easy to add new tools without touching the core loop. The `buildTool()` factory with `ToolDef` type, read-only concurrency classification for parallel execution, and tool-specific result truncation is a clean pattern to adopt.

- **Hooks and skills provide the right extensibility surface**: Rather than asking users to modify agent source code, Claude Code exposes 27 hook events and a markdown-based skill system. This lets users customize behavior (block tools, inject context, auto-approve, run post-processing) without touching the core. The `paths:` frontmatter for conditional activation (skills/rules only load when matching files are touched) is a clever way to keep context lean.
