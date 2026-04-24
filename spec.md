# Chimera — Engineering Spec (V1)

**Status:** Draft v0.3
**Scope:** V1 core + TUI + SDK + Docker sandbox (with overlay modes) + permission model + skills + commands + subagents. Slack/cloud harness deferred to V2.
**Target implementer:** Claude Code

---

## 1. Overview

Chimera is a terminal-native AI coding agent in the vein of Claude Code, OpenCode, and Pi, with these defining properties:

1. **TUI-first** for interactive use.
2. **SDK-first** so an outer agent (future Slack harness) can drive it programmatically.
3. **Sandbox-capable** — a `--sandbox` flag routes tool execution through a Docker container, with optional overlay filesystem modes for stronger isolation.
4. **Permission-aware** — even when sandboxed, the agent can request host execution for integration tests, deploys, etc., via a per-call approval flow with pattern-based remembering.
5. **Extensible via skills and commands** — Claude Code-compatible markdown files for model-invoked capabilities (skills) and user-invoked prompt templates (commands).
6. **Self-recursive** — Chimera can spawn subagents that are themselves Chimera instances driven via the SDK. No separate subagent abstraction; dogfooding the SDK is the subagent system.

The agent loop is built on the Vercel AI SDK (`streamText` with tool calling). Provider support is **shape-based, not vendor-locked**: any OpenAI-compatible or Anthropic-compatible endpoint works via `baseURL` configuration. Primary targets: Anthropic API, OpenAI API, OpenRouter, local vLLM/Ollama, AWS Bedrock/GCP Vertex proxies.

## 2. Process architecture

**Per-invocation server + TUI pair, not a global daemon.** Each `chimera` command spawns its own HTTP server on an ephemeral port; the TUI connects as a client. Both die when the invocation ends.

### Entry points

| Command                      | Behavior                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `chimera`                    | Spawns server + TUI in one process, interactive session.                                 |
| `chimera run "prompt"`       | One-shot: spawns server, runs prompt non-interactively, streams result to stdout, exits. |
| `chimera run --stdin`        | Reads prompt from stdin (for piping).                                                    |
| `chimera serve`              | Starts only the server. Prints URL and instance ID. Stays alive until killed.            |
| `chimera attach <id-or-url>` | Starts only the TUI, connects to existing server.                                        |
| `chimera ls`                 | Lists running instances from lockfiles.                                                  |

### Instance discovery

- On server start, write `~/.chimera/instances/<pid>.json`: `{pid, port, cwd, sessionId, startedAt, version}`.
- On clean shutdown, delete the lockfile.
- On `chimera ls`, scan dir and filter out stale entries (dead pids).
- Ephemeral ports: bind to `127.0.0.1:0`, read back the assigned port.

### Process tree (default `chimera` invocation)

```
chimera (CLI process)
├── HTTP server (same event loop)
└── TUI (Ink, same process)
```

### 2.1 Server: same-process or child-process?

**Decision: same-process in V1.** The HTTP server runs in the CLI's Node event loop; the TUI is an Ink app in the same process. Local TUI talks to the server via an in-memory `fetch`-compatible transport; remote clients (`chimera attach`) use the real HTTP server on the bound port. The HTTP server always binds a real port so any attach/SDK client can connect — this is what makes every `chimera` invocation automatically attachable.

## 3. Monorepo layout

```
/packages
  /core          @chimera/core         — agent loop, session state, event emission
  /providers     @chimera/providers    — OpenAI/Anthropic-compat provider factories
  /tools         @chimera/tools        — bash, read, write, edit + Executor interface
  /skills        @chimera/skills       — skill discovery, loading, system prompt injection
  /commands      @chimera/commands     — slash-command discovery, template expansion
  /subagents     @chimera/subagents    — spawn_agent tool, child process management
  /sandbox       @chimera/sandbox      — DockerExecutor, overlay modes
  /permissions   @chimera/permissions  — GatedExecutor, rule matching, persistence
  /server        @chimera/server       — HTTP+SSE surface
  /client        @chimera/client       — typed SDK client
  /tui           @chimera/tui          — Ink UI
  /cli           @chimera/cli          — entry point
/apps            (empty in V1; V2 adds slack-runner)
```

**Tooling:** pnpm workspaces, TypeScript strict, tsup, vitest, biome.

**Dependency DAG (strict):**

```
cli → tui, server, client, subagents, sandbox, permissions, skills, commands, tools, providers, core
tui → client, commands
server → core, permissions, tools, skills
client → (types from core only)
subagents → client, tools (provides spawn_agent tool)
sandbox → tools (implements Executor)
permissions → tools (wraps Executor), core (event types)
skills → core (for system prompt injection hooks)
commands → (no internal deps; pure template expansion)
tools → core (Executor interface, events)
providers → core (ModelClient interface)
core → (no internal deps)
```

## 4. Core package (`@chimera/core`)

### 4.1 Responsibilities

- Session state (messages, tool calls, metadata)
- Agent loop: stream model, dispatch tools, feed results back, loop until terminal
- Event emission for everything observable
- Permission request plumbing (core raises the event; permissions package resolves it)
- No I/O assumptions: knows nothing about TTYs, HTTP, Docker

### 4.2 Public types

```ts
type SessionId = string; // ULID
type EventId = string;
type CallId = string;

interface Session {
  id: SessionId;
  cwd: string;
  createdAt: number;
  messages: Message[]; // AI SDK CoreMessage[]
  toolCalls: ToolCallRecord[];
  status:
    | "idle"
    | "running"
    | "waiting_for_input"
    | "waiting_for_permission"
    | "error";
  model: ModelConfig;
  sandboxMode: SandboxMode;
}

interface ModelConfig {
  providerId: string; // user-defined, e.g. 'anthropic', 'openrouter', 'local-vllm'
  modelId: string; // provider-specific, e.g. 'claude-opus-4-7', 'anthropic/claude-opus-4'
  maxSteps: number; // agent loop cap (default 100)
  maxTokens?: number;
  temperature?: number;
}

type SandboxMode = "off" | "bind" | "overlay" | "ephemeral";

type AgentEvent =
  | { type: "session_started"; sessionId: SessionId }
  | { type: "user_message"; content: string }
  | { type: "assistant_text_delta"; delta: string }
  | { type: "assistant_text_done"; text: string }
  | {
      type: "tool_call_start";
      callId: CallId;
      name: string;
      args: unknown;
      target: ExecutionTarget;
    }
  | {
      type: "tool_call_result";
      callId: CallId;
      result: unknown;
      durationMs: number;
    }
  | { type: "tool_call_error"; callId: CallId; error: string }
  | {
      type: "permission_request";
      requestId: string;
      tool: string;
      target: "host";
      command: string;
      reason?: string;
    }
  | {
      type: "permission_resolved";
      requestId: string;
      decision: "allow" | "deny";
      remembered: boolean;
    }
  | {
      type: "skill_activated";
      skillName: string;
      source: "project" | "user" | "claude-compat";
    }
  | { type: "command_invoked"; commandName: string; expandedPrompt: string }
  | {
      type: "subagent_spawned";
      subagentId: string;
      parentCallId: CallId;
      sessionId: SessionId;
      url: string;
    }
  | { type: "subagent_event"; subagentId: string; event: AgentEvent } // nested events from children
  | {
      type: "subagent_finished";
      subagentId: string;
      parentCallId: CallId;
      result: string;
      reason: string;
    }
  | { type: "step_finished"; stepNumber: number; finishReason: string }
  | {
      type: "run_finished";
      reason: "stop" | "max_steps" | "error" | "interrupted";
      error?: string;
    };

type ExecutionTarget = "sandbox" | "host";
```

### 4.3 Agent class

```ts
interface AgentOptions {
  cwd: string;
  model: ModelConfig;
  modelClient: ModelClient; // from @chimera/providers
  executor: Executor; // GatedExecutor if sandboxed, LocalExecutor if not
  systemPrompt?: string;
  tools?: Tool[];
  sessionId?: SessionId;
  sandboxMode: SandboxMode;
}

class Agent {
  constructor(opts: AgentOptions);
  readonly session: Session;

  run(userMessage: string): AsyncIterable<AgentEvent>;
  interrupt(): void;
  resolvePermission(
    requestId: string,
    decision: "allow" | "deny",
    remember?: RememberScope,
  ): void;
  snapshot(): Session;
}

type RememberScope =
  | { scope: "session" }
  | { scope: "project"; pattern: string; patternKind: "exact" | "glob" };
```

### 4.4 Agent loop

Uses AI SDK `streamText` with `stopWhen: stepCountIs(maxSteps)`.

```
append user message to session
stream = streamText({ model, messages, tools, stopWhen, abortSignal })
for await (part of stream.fullStream):
  switch part.type:
    'text-delta'   -> emit assistant_text_delta
    'tool-call'    -> dispatch via executor (which may pause for permission); emit tool_call_start
    'tool-result'  -> emit tool_call_result
    'tool-error'   -> emit tool_call_error
    'finish-step'  -> emit step_finished; persist session
    'finish'       -> break
append assistant messages to session
emit run_finished
```

**Interrupt:** `AbortController` wired into `streamText`. Tools receive the signal; bash tool passes it to `child_process.spawn({ signal })`.

**Permission pauses:** when a tool call requests a target that requires approval, the executor's promise blocks on a resolution latch. Agent emits `permission_request`, session status → `waiting_for_permission`. When `resolvePermission()` is called (via SDK/TUI), the latch releases and the tool executes (or returns a denial result to the model).

### 4.5 System prompt

Short and focused, Pi-inspired. Kept in `packages/core/src/prompts/system.ts`, ~300–500 words. Covers: role, available tools, efficiency (prefer small diffs, minimal narration), **how to use the `target` parameter** (default to sandbox, only request `host` when genuinely needed, always provide a `reason`).

Discovers and appends `AGENTS.md`: walks up from cwd to nearest git root (or home), concatenates any found along the way (closer = later = higher priority).

### 4.6 Persistence (V1)

Each session written to `~/.chimera/sessions/<sessionId>.json` on every `step_finished`. Load on resume. Schema = `Session` type. Revisit if sessions exceed ~10MB (V2 concern).

## 5. Providers package (`@chimera/providers`)

Thin wrapper that turns config into an AI SDK `LanguageModel` instance.

### 5.1 Provider shapes

Two supported shapes in V1:

- **`anthropic`**: uses `@ai-sdk/anthropic`'s `createAnthropic({ baseURL, apiKey })`
- **`openai`**: uses `@ai-sdk/openai`'s `createOpenAI({ baseURL, apiKey, compatibility: 'strict' | 'compatible' })`

### 5.2 Config format

```json
{
  "providers": {
    "anthropic": {
      "shape": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "env:ANTHROPIC_API_KEY"
    },
    "openai": {
      "shape": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "env:OPENAI_API_KEY"
    },
    "openrouter": {
      "shape": "openai",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "env:OPENROUTER_API_KEY"
    },
    "local-vllm": {
      "shape": "openai",
      "baseUrl": "http://localhost:8000/v1",
      "apiKey": "unused"
    },
    "bedrock-proxy": {
      "shape": "anthropic",
      "baseUrl": "https://my-bedrock-proxy.example.com/v1",
      "apiKey": "env:BEDROCK_PROXY_KEY"
    }
  },
  "defaultModel": "anthropic/claude-opus-4-7"
}
```

Model selection uses `<providerId>/<modelId>` format. The providerId is a local alias — whatever the user named the provider in config.

### 5.3 Surface

```ts
interface ProviderRegistry {
  get(providerId: string): Provider;
  resolve(modelRef: string): { provider: Provider; modelId: string }; // parses "id/model"
}

interface Provider {
  id: string;
  shape: "openai" | "anthropic";
  getModel(modelId: string): LanguageModel; // AI SDK type
}

function loadProviders(config: ProvidersConfig): ProviderRegistry;
```

### 5.4 Compatibility caveats (documented, not coded around in V1)

Some OpenAI/Anthropic-compatible proxies are only partially compatible. Common gotchas:

- OpenRouter's Anthropic endpoint historically has passed through `cache_control` inconsistently — prefer the OpenAI-shaped endpoint when using Anthropic models via OpenRouter if caching matters.
- Local vLLM with OpenAI-shape tool calling is fine for most models; some smaller models hallucinate tool JSON. Not Chimera's problem to fix.
- Anthropic's `extended_thinking` / `thinking` blocks are Anthropic-only; using them against an OpenAI-shape endpoint just omits them.

Chimera does not auto-detect these — user responsibility to pick a working provider/shape combination. We document known-good combos in a `PROVIDERS.md`.

### 5.5 Auth

API keys resolved from `env:VAR_NAME` references, a keychain integration (deferred to V2), or direct strings in config (discouraged, warned). Never logged.

## 6. Tools package (`@chimera/tools`)

### 6.1 Executor interface

The abstraction that makes sandboxing and permissions work. Tools never touch `child_process` or `fs` directly.

```ts
interface Executor {
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  stat(
    path: string,
  ): Promise<{ exists: boolean; isDir: boolean; size: number } | null>;
  cwd(): string;
  target(): ExecutionTarget; // 'sandbox' or 'host'
}

interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number; // default 120_000
  signal?: AbortSignal;
  stdin?: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}
```

### 6.2 LocalExecutor

Implements `Executor` with `node:fs/promises` and `node:child_process.spawn`. Resolves paths against the configured root (cwd). Rejects path escapes (absolute paths outside root, `..` traversal past root).

### 6.3 Tools

Defined with Vercel AI SDK's `tool()` + Zod schemas. A single `buildTools(ctx)` function returns the tool set; `ctx` carries the executor(s) and permission gate.

**`bash`**

```ts
{
  command: string,
  timeout_ms?: number,              // default 120000
  target?: 'sandbox' | 'host',      // default 'sandbox' if sandboxed, else 'host'
  reason?: string                   // required when target='host' in sandbox mode
}
→ { stdout, stderr, exit_code, timed_out }
```

Safety: block a small list of known-destructive patterns (`rm -rf /`, fork bombs, writes to `/etc` etc.) and return as error. Not a security boundary — the sandbox is. Just prevents dumb mistakes.

**`read`**

```ts
{ path: string, start_line?: number, end_line?: number }
→ { content, total_lines, truncated }
```

Numbered output. Limits: 2000 lines or 100KB, whichever first. Always uses sandbox filesystem when sandboxed (no `target` param — reads are safe).

**`write`**

```ts
{ path: string, content: string }
→ { bytes_written, created }
```

Full-file overwrite. Creates parent dirs. Refuses paths outside cwd. Always sandbox-filesystem when sandboxed.

**`edit`**

```ts
{ path: string, old_string: string, new_string: string, replace_all?: boolean }
→ { replacements }
```

Exact string match, no regex. Errors: not found; ambiguous (>1 match with `replace_all=false`).

### 6.4 Why only `bash` has `target`

File operations in sandbox mode always target the sandbox filesystem. If the user is in `--sandbox-mode overlay`, the overlay captures file writes automatically — no need for the model to decide. But `bash` is where the real out-of-sandbox cases live (run the e2e suite, deploy, hit staging DB). So `target` is a `bash`-only concept in V1.

### 6.5 Tool context

```ts
interface ToolContext {
  sandboxExecutor: Executor; // always set; === hostExecutor when sandbox mode = 'off'
  hostExecutor: Executor; // always LocalExecutor on the host
  permissionGate: PermissionGate; // from @chimera/permissions
  sandboxMode: SandboxMode;
}

function buildTools(ctx: ToolContext): Record<string, Tool>;
```

The `bash` tool picks its executor based on `args.target`, routes through `permissionGate` if `target === 'host' && sandboxMode !== 'off'`.

## 7. Sandbox package (`@chimera/sandbox`)

### 7.1 Sandbox modes

| Mode        | Process iso | FS iso                      | Persistence                                                         | Use case                                                                    |
| ----------- | ----------- | --------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `off`       | none        | none                        | n/a                                                                 | Default when `--sandbox` not set                                            |
| `bind`      | Docker      | none (rw bind-mount of cwd) | changes land directly on host                                       | Default when `--sandbox` set. Agent edits your files; rely on git for undo. |
| `overlay`   | Docker      | overlayfs                   | changes in persistent upperdir, applied on session end after review | Riskier tasks; review before keeping changes                                |
| `ephemeral` | Docker      | overlayfs                   | upperdir in tmpfs, discarded on exit                                | Throwaway exploration ("what does this repo do?")                           |

### 7.2 DockerExecutor

Implements `Executor` by proxying to a long-lived container.

**Lifecycle:**

- `start()`: `docker run -d --name chimera-<sessionId> --workdir /workspace <mount-args> <image> sleep infinity`
- `exec()`: `docker exec -w <relCwd> -i <name> sh -c '<cmd>'`; stdin piped, env via `-e`, timeout via `setTimeout` + `docker kill --signal=SIGTERM` then SIGKILL
- `readFile`/`writeFile`: `docker exec` + `cat`/`tee` (avoids a helper binary)
- `stop()`: `docker rm -f <name>`

**Mount strategy by mode:**

| Mode        | Mount                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `bind`      | `-v <hostCwd>:/workspace:rw`                                                                    |
| `overlay`   | `-v <hostCwd>:/lower:ro` + `-v <overlayDir>:/upper` + entrypoint mounts `/workspace` as overlay |
| `ephemeral` | same as `overlay` but `/upper` is tmpfs                                                         |

### 7.3 Overlay implementation

Overlays need `CAP_SYS_ADMIN` on the container and a kernel with overlayfs (Linux ≥3.18, all modern Docker hosts).

Container entrypoint script:

```sh
#!/bin/sh
mkdir -p /upper/data /upper/work
mount -t overlay overlay \
  -o lowerdir=/lower,upperdir=/upper/data,workdir=/upper/work \
  /workspace
exec sleep infinity
```

`docker run` gets `--cap-add SYS_ADMIN --security-opt apparmor=unconfined` (the AppArmor relaxation is the irritating part on some Ubuntu hosts; document the alternative of `--privileged` as a fallback with a warning).

Host-side upperdir layout for `overlay` mode (not `ephemeral`):

```
~/.chimera/overlays/<sessionId>/
  upper/    # mounted as /upper/data in container
  work/     # mounted as /upper/work in container
```

### 7.4 Diff-and-apply flow (overlay mode)

On session end in `overlay` mode:

1. Compute diff: `rsync --dry-run -rln --delete <upperdir>/ <hostCwd>/` → list of changes
2. TUI shows changed files grouped as: `modified`, `added`, `deleted`
3. User picks: `apply all`, `apply selected`, `discard`, `keep overlay for later`
4. On apply: `rsync -a [--delete] <upperdir>/ <hostCwd>/` for the selected subset
5. On `keep`, upperdir is preserved; resuming that session reattaches the same overlay

Non-TTY / `chimera run` mode: default is `discard` unless `--apply-on-success` is passed, in which case apply only if `run_finished.reason === 'stop'`. Makes overlay mode usable in automation.

### 7.5 Overlay fallback

If overlayfs unavailable (no `CAP_SYS_ADMIN`, managed Docker, Docker Desktop on macOS quirks):

- Detect at `start()`: try the overlay mount; if it fails, log a clear error and fall back to `bind` mode with a visible warning.
- `--sandbox-strict` refuses fallback and errors out instead.

### 7.6 Default image

`ghcr.io/<org>/chimera-sandbox:<version>`. Slim Debian base + git, curl, node, python3, build-essential, ripgrep, jq, fd-find. Dockerfile at `packages/sandbox/docker/Dockerfile`. Configurable via `--sandbox-image <ref>`. Escape hatch: `chimera sandbox build` builds locally.

### 7.7 Network and resources

Defaults: allow network (agents need npm/pypi), `--memory 2g --cpus 2`.

Flags:

```
--sandbox                                Enable sandbox (default mode: bind)
--sandbox-mode bind|overlay|ephemeral    Sandbox mode
--sandbox-strict                         Refuse fallback (error if overlay unsupported)
--sandbox-image <ref>                    Override image
--sandbox-network none|host              Network mode
--sandbox-memory <size>                  Memory limit
--sandbox-cpus <n>                       CPU limit
--apply-on-success                       (overlay only) Auto-apply overlay if run succeeded
```

### 7.8 What the sandbox does and doesn't protect

**Protects against (all sandbox modes):**

- Arbitrary binaries on host, fork bombs, process runaways
- Accidental `sudo`/package installs polluting host
- Reading host files outside `/workspace`

**`overlay`/`ephemeral` additionally protect against:**

- Destruction of files in the cwd (changes are isolated until reviewed)

**Does not protect against (any mode):**

- Network egress without `--sandbox-network none`
- Data exfiltration via network (if enabled)
- Attacks on the Docker daemon itself (trust model: Docker is part of TCB)

## 8. Permissions package (`@chimera/permissions`)

### 8.1 Permission model

Three tiers of auto-approval, configurable via `--auto-approve`:

| Level                                | Behavior                                                      |
| ------------------------------------ | ------------------------------------------------------------- |
| `none`                               | Prompt for every tool call that has a permission surface      |
| `sandbox` (default when `--sandbox`) | Auto-approve all in-sandbox tool calls; prompt for host calls |
| `host`                               | Auto-approve host calls                                       |
| `all`                                | Auto-approve everything                                       |

Sandbox tool calls have no permission surface by design — the sandbox _is_ the approval. Permission prompts are scoped to host-target calls, which are the meaningful ones.

When sandbox is off (`--sandbox` not set), all calls are host calls; default `--auto-approve` is `host` for UX parity with Claude Code et al. Users who want Claude-Code-style permission prompts for everything pass `--auto-approve none`.

### 8.2 GatedExecutor

Wraps another `Executor` (typically `LocalExecutor` for host ops). Before each `exec()`, checks the rule store and auto-approve level; if approval is needed, raises `permission_request` event, waits for resolution.

```ts
class GatedExecutor implements Executor {
  constructor(opts: {
    inner: Executor;
    gate: PermissionGate;
    target: ExecutionTarget;
  });
  // ...
}

interface PermissionGate {
  request(req: PermissionRequest): Promise<PermissionResolution>;
  addRule(rule: PermissionRule, persist: "session" | "project"): void;
  check(req: PermissionRequest): PermissionResolution | null; // matches rules, returns null if no match
}

interface PermissionRequest {
  requestId: string;
  tool: string; // e.g. 'bash'
  target: "host";
  command: string;
  reason?: string;
  cwd: string;
}

interface PermissionResolution {
  decision: "allow" | "deny";
  remember?: RememberScope;
}

interface PermissionRule {
  tool: string;
  target: ExecutionTarget;
  pattern: string;
  patternKind: "exact" | "glob";
  decision: "allow" | "deny";
  createdAt: number;
}
```

### 8.3 Rule matching

- **Exact:** full string equality on the command.
- **Glob:** shell-style globs (via `minimatch`). Examples: `pnpm run test:*`, `docker compose *`, `git push *`.
- **Order:** deny rules win over allow rules; more specific patterns win over less specific (longer pattern = more specific; rough heuristic, good enough for V1).
- **No regex** in V1 (complexity/safety tradeoff).

### 8.4 Rule storage

Two scopes:

**Session-scoped** — in-memory only, cleared on session end.

**Project-scoped** — `./.chimera/permissions.json` in the cwd. Created on first rule. Intended to be committable (but `.chimera/` should be gitignored by default for sessions/logs; docs explain the split — permissions.json is the one file you may want committed).

```json
{
  "version": 1,
  "rules": [
    {
      "tool": "bash",
      "target": "host",
      "pattern": "pnpm run test:*",
      "patternKind": "glob",
      "decision": "allow",
      "createdAt": 1729900000000
    }
  ]
}
```

V2 may add user-scope (`~/.chimera/permissions.json`) for rules like "always allow `git status`".

### 8.5 Permission UX (TUI)

When `permission_request` fires, TUI shows:

```
┌─ Permission required ────────────────────────────────────┐
│ The agent wants to run on the HOST (outside sandbox):    │
│                                                          │
│   $ pnpm run test:e2e                                    │
│                                                          │
│ Reason: integration tests need real network              │
│                                                          │
│ [a] Allow once       [A] Allow & remember this command   │
│ [g] Allow pattern... [d] Deny once                       │
│ [D] Deny & remember  [?] Show full command details       │
└──────────────────────────────────────────────────────────┘
```

Allow pattern (`g`) opens a sub-prompt: "Pattern?" with the command prefilled, user can edit to a glob. Scope prompt: "Remember for [s]ession or [p]roject?".

### 8.6 Permission UX (headless / `chimera run`)

- Default: deny host calls, tool returns error to model, model can retry without host target or give up.
- `--auto-approve host` or `--auto-approve all`: auto-allow.
- Project-scope rules always consulted.
- `--permission-prompt-via <command>`: escape hatch for V2 Slack harness — Chimera calls external command with request JSON, reads decision from stdout. V1 spec'd but not implemented unless time allows.

## 9. Skills package (`@chimera/skills`)

Skills are **model-invoked capabilities**. Each skill is a markdown file with YAML frontmatter describing when to use it. At session start, Chimera builds a skill index and injects it into the system prompt. The model activates a skill by reading its SKILL.md via the existing `read` tool — no new tool needed.

### 9.1 Skill file format (Claude Code compatible)

```
.chimera/skills/<skill-name>/SKILL.md
.chimera/skills/<skill-name>/                 # bundled resources (scripts, templates)
```

`SKILL.md`:

```yaml
---
name: pdf
description: Create, read, or manipulate PDF files. Use when the user mentions PDFs, asks to extract text from PDFs, fill forms, merge/split documents, etc.
---

# PDF Skill

Instructions the model should follow when working with PDFs.

## Scripts

This skill bundles helper scripts in the skill directory:
- `scripts/extract_text.py` — extract text from a PDF
- `scripts/merge.py` — merge multiple PDFs

Invoke them via bash: `python .chimera/skills/pdf/scripts/extract_text.py <file>`
```

Frontmatter required fields: `name`, `description`. Optional: `version`, `license` (for ecosystem sharing in V2).

### 9.2 Discovery paths

Discovery order (first match wins per skill name):

1. `<cwd>/.chimera/skills/<n>/SKILL.md`
2. Walking up from cwd to nearest git root: `<ancestor>/.chimera/skills/<n>/SKILL.md`
3. `~/.chimera/skills/<n>/SKILL.md`

**Claude Code compat paths** (read-only, opt-out via `skillCompat: false` in config):

4. `<cwd>/.claude/skills/<n>/SKILL.md`
5. Walking up: `<ancestor>/.claude/skills/<n>/SKILL.md`
6. `~/.claude/skills/<n>/SKILL.md`

Name collisions: Chimera paths win over Claude compat paths; closer wins over farther. Collisions logged at session start.

### 9.3 Skill index injection

At session start, the skills package builds a compact index and appends it to the system prompt:

```
# Available skills

You have access to skills — specialized instructions loaded on demand. Each skill has a name, description, and a SKILL.md file you can read with the `read` tool when relevant.

- pdf — Create, read, or manipulate PDF files. Use when...
  path: .chimera/skills/pdf/SKILL.md
- docx — Work with Word documents...
  path: ~/.chimera/skills/docx/SKILL.md

To activate a skill, read its SKILL.md. The skill's content will then be available as context.
```

The full content of each SKILL.md is **not** loaded upfront — only name, description, and path. Activation happens when the model reads the file, keeping context efficient.

### 9.4 Surface

```ts
interface Skill {
  name: string;
  description: string;
  path: string; // absolute path to SKILL.md
  source: "project" | "user" | "claude-compat";
  frontmatter: Record<string, unknown>;
}

interface SkillRegistry {
  all(): Skill[];
  find(name: string): Skill | null;
  buildIndex(): string; // formatted block for system prompt
}

function loadSkills(opts: {
  cwd: string;
  userHome: string;
  includeClaudeCompat: boolean;
}): Promise<SkillRegistry>;
```

### 9.5 Activation tracking

When the model reads a SKILL.md file, the tools package detects this (by path pattern matching against the registry) and emits a `skill_activated` event. Purely observational; no behavior change. Lets the TUI display "📚 using skill: pdf" and helps debug "why did the model do X."

### 9.6 Built-in skills

V1 ships with zero built-in skills. Users and projects add their own, or point to Claude Code's skill repositories. This matches Pi's philosophy — the agent is a blank canvas.

## 10. Commands package (`@chimera/commands`)

Commands are **user-invoked prompt templates**. A command is a markdown file; typing `/name args...` in the TUI (or passing `--command` in run mode) expands the template and sends it as a user message.

### 10.1 Command file format (Claude Code compatible)

```
.chimera/commands/<command-name>.md
```

```yaml
---
description: Review the current diff for issues
---

Review the diff between `main` and the current branch.
Focus: $ARGUMENTS

Check for:
- Bugs and logic errors
- Missing tests
- Security issues ($1 if specified)
```

Frontmatter: `description` (optional; shown in `/help`). Body is the prompt template.

### 10.2 Placeholders

- `$ARGUMENTS` — entire arg string after the command name
- `$1`, `$2`, ... — whitespace-separated positional args
- `$CWD` — current working directory
- `$DATE` — ISO date
- Unknown placeholders left as-is (so `$PATH` in shell snippets survives)

### 10.3 Discovery paths

Same strategy as skills:

1. `<cwd>/.chimera/commands/<n>.md`
2. Walking up: `<ancestor>/.chimera/commands/<n>.md`
3. `~/.chimera/commands/<n>.md`
4. Claude compat: `<cwd>/.claude/commands/<n>.md`, ancestors, `~/.claude/commands/<n>.md`

Conflict resolution same as skills. `.chimera/commands/foo.md` beats `.claude/commands/foo.md`.

### 10.4 Invocation paths

**TUI:** typing `/name args` at the prompt. TUI intercepts before sending, calls `expandCommand`, replaces the user input with the expanded prompt, sends as a normal message.

**CLI:** `chimera run --command review --args "auth module"` expands the template and runs one-shot.

**SDK:** `client.expandCommand(name, args)` returns the string; caller decides what to do with it. Commands never touch the server — pure client-side expansion.

### 10.5 Surface

```ts
interface Command {
  name: string;
  description?: string;
  path: string;
  source: "project" | "user" | "claude-compat";
  body: string;
}

interface CommandRegistry {
  all(): Command[];
  find(name: string): Command | null;
  expand(name: string, args: string): string; // throws if command not found
}

function loadCommands(opts: {
  cwd: string;
  userHome: string;
  includeClaudeCompat: boolean;
}): Promise<CommandRegistry>;
```

### 10.6 Built-in commands

V1 ships with a small set, implemented as bundled `.md` files in `@chimera/commands/builtin/`:

- `/help` — list all commands with descriptions
- `/clear` — clear scrollback (TUI handles, not a template)
- `/new` — new session (TUI handles)
- `/model` — show/switch model (TUI handles)

`/help`, `/clear`, etc. are handled by the TUI directly, not expanded as templates. Commands in the `.md` directory are for user templates.

### 10.7 Relationship to skills

Commands and skills are **deliberately separate primitives**:

- **Skills** → model decides when to activate, based on task relevance. Content loaded on demand. No user ceremony.
- **Commands** → user triggers explicitly, pure template expansion. Deterministic. No model involvement in activation.

A command can instruct the model to use a skill ("review this code using the security-review skill") but they're not the same mechanism. This matches Claude Code's model and keeps the ecosystem compatible.

## 11. Subagents package (`@chimera/subagents`)

Subagents in Chimera are **nested Chimera instances driven through the SDK**. There is no separate subagent abstraction — a subagent is `spawn chimera serve` + `new ChimeraClient(...)` orchestrated via a `spawn_agent` tool. This dogfoods the SDK and gives subagents every property of top-level Chimera instances: own session, own sandbox, attachable via TUI, visible in `chimera ls`.

### 11.1 `spawn_agent` tool

Registered as a regular tool when subagents are enabled.

```ts
{
  prompt: string,                       // what to ask the subagent
  purpose: string,                      // short description for logs/UI
  cwd?: string,                         // default: parent cwd
  model?: string,                       // default: parent model
  tools?: string[],                     // default: ['bash', 'read', 'write', 'edit']
  system_prompt?: string,               // overrides default
  sandbox?: boolean,                    // default: inherit parent
  sandbox_mode?: 'bind' | 'overlay' | 'ephemeral',
  timeout_ms?: number,                  // default 600000 (10min)
  in_process?: boolean                  // default false; see §11.5
}
→ {
  subagent_id: string,
  result: string,                       // final assistant message from subagent
  reason: 'stop' | 'max_steps' | 'error' | 'timeout' | 'interrupted',
  session_id: string,
  steps: number,
  tool_calls_count: number
}
```

### 11.2 Lifecycle (child-process mode, default)

1. Parent's `spawn_agent` tool invocation begins.
2. Tool spawns: `chimera serve --cwd <x> --auto-approve <inherited> [sandbox flags] --machine-handshake`
3. `--machine-handshake` mode causes the child to emit a single JSON line to stdout on ready: `{"ready":true,"url":"http://127.0.0.1:54321","sessionId":"..."}`. Parent reads this line and stops capturing stdout after.
4. Parent constructs `new ChimeraClient({ baseUrl: url })`, emits `subagent_spawned` event.
5. Parent calls `client.send(sessionId, prompt)`, consumes the event stream.
6. Every subagent event is re-emitted by the parent as `subagent_event { subagentId, event }`.
7. On subagent's `run_finished`, parent extracts the final `assistant_text_done` as `result`.
8. Parent calls `client.deleteSession` + sends SIGTERM to child. On timeout, SIGKILL.
9. Parent emits `subagent_finished`, returns tool result to parent's model.

### 11.3 Permission inheritance

Default: child inherits parent's `--auto-approve` level and loads parent's project rules file (`./.chimera/permissions.json`). This means:

- Sandbox-mode parent with default `--auto-approve sandbox` → child has same. Sandbox calls auto-approve; host calls prompt.
- But if the parent is non-interactive (no TUI), the child also has no TUI. A host permission request in the child would block forever.

Resolution: **if the parent's stdio has no TTY, the child inherits `--permission-prompt-via` pointed back at the parent**, so the child's permission requests bubble up to the parent's SDK consumer as `subagent_event { type: 'permission_request' }`. The outer consumer (TUI if attached, Slack harness in V2, or the parent model via some mechanism) decides.

V1 simplification: if the parent has a TTY, child permission prompts go to the parent's TUI via the subagent event stream. If the parent doesn't have a TTY, host permissions in children auto-deny (return as error to the child's model). V2 adds proper bubble-up chains.

### 11.4 Observability

Because each subagent is a real `chimera serve` instance:

- It writes a lockfile → `chimera ls` shows it as a running instance
- It exposes the HTTP+SSE API → any user can `chimera attach <subagent-id>` to watch/intervene from another terminal
- It has its own session → `chimera sessions` shows it (flagged `parentId: <parent-session>`)
- Logs land in `~/.chimera/logs/` with a `subagent_of: <parent-id>` field

This is the dogfooding payoff: all the introspection tooling built for top-level Chimera works on subagents for free.

### 11.5 In-process mode (opt-in, V1.1 or late V1)

For high-fanout cases (research 20 topics in parallel, generate many file diffs), child-process spawn is too slow (~500ms each, RAM overhead). `in_process: true` bypasses the child process: constructs a new `Agent` in the same Node process, wraps it in an in-memory client, runs it.

Tradeoffs vs. child-process:

- ✅ Fast spawn (< 10ms)
- ✅ Low memory
- ❌ Not attachable via `chimera attach`
- ❌ Doesn't appear in `chimera ls`
- ❌ Crash in subagent can affect parent

Default stays **child-process** so attach/ls/observability work. In-process is opt-in.

### 11.6 Nesting

Subagents can spawn subagents (they have the tool). Default max depth: 3. Configurable via `--max-subagent-depth` or config. Prevents runaway recursion.

### 11.7 Resource accounting

Each subagent's token usage is tracked in its own session. Parent's `subagent_finished` event includes a `usage` summary. Costs roll up in aggregate logs but not in real time — the parent model sees only the subagent's textual result, not its token bill.

### 11.8 Interrupting subagents

Parent `interrupt()` cascades: parent's abort signal propagates to the `spawn_agent` tool, which calls `client.interrupt()` on the child, then SIGTERM. Parent's `run_finished { reason: 'interrupted' }` fires after all children clean up.

### 11.9 Surface

```ts
interface SubagentSpawnOptions {
  prompt: string;
  purpose: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  sandbox?: boolean;
  sandboxMode?: SandboxMode;
  timeoutMs?: number;
  inProcess?: boolean;
}

interface SubagentResult {
  subagentId: string;
  result: string;
  reason: "stop" | "max_steps" | "error" | "timeout" | "interrupted";
  sessionId: SessionId;
  steps: number;
  toolCallsCount: number;
  usage?: { inputTokens: number; outputTokens: number };
}

function buildSpawnAgentTool(ctx: {
  parentSessionId: SessionId;
  parentCwd: string;
  parentAutoApprove: AutoApproveLevel;
  maxDepth: number;
  currentDepth: number;
}): Tool;
```

## 12. Server package (`@chimera/server`)

HTTP + SSE over Hono.

### 12.1 Endpoints

```
POST   /v1/sessions                               Create → { sessionId }
GET    /v1/sessions                               List
GET    /v1/sessions/:id                           Snapshot
DELETE /v1/sessions/:id                           Delete
POST   /v1/sessions/:id/messages                  Send user message (queues run)
POST   /v1/sessions/:id/interrupt                 Interrupt run
POST   /v1/sessions/:id/permissions/:requestId    Resolve pending permission request
                                                  body: { decision, remember? }
POST   /v1/sessions/:id/permissions/rules         Add a rule directly (for TUI/SDK)
GET    /v1/sessions/:id/permissions/rules         List active rules
DELETE /v1/sessions/:id/permissions/rules/:idx
GET    /v1/sessions/:id/events                    SSE stream of AgentEvents
GET    /v1/sessions/:id/events?since=<eventId>    Resume from eventId
GET    /v1/instance                               { pid, cwd, version, sandboxMode, parentId? }
GET    /healthz
```

### 12.2 SSE format

```
event: agent_event
id: <eventId>
data: <JSON AgentEvent + { eventId, sessionId, ts }>
```

Ring buffer of last 1000 events per session for resume.

### 12.3 Auth

V1: `127.0.0.1` bind only. No auth. Exposing to network is user's problem (reverse proxy). V2 adds bearer tokens for Slack.

### 12.4 Concurrency

- Map `sessionId → Agent`.
- One active `run()` per session; second `POST /messages` during run returns 409.
- Multiple SSE subscribers per session; events fan out from agent's stream.
- Permission resolutions idempotent — repeated POST to same `requestId` returns 409 after first resolution.

### 12.5 Machine handshake mode

`chimera serve --machine-handshake` emits a single JSON line to stdout on ready:

```
{"ready":true,"url":"http://127.0.0.1:54321","sessionId":"01J...","pid":12345}
```

Used by `spawn_agent` to bootstrap subagents without racing on the lockfile.

## 13. Client package (`@chimera/client`)

Typed TypeScript client. **This is the SDK.**

### 13.1 Surface

```ts
class ChimeraClient {
  constructor(opts: { baseUrl: string; fetch?: typeof fetch });

  createSession(opts: {
    cwd: string;
    model?: ModelConfig;
    sandboxMode?: SandboxMode;
  }): Promise<{ sessionId }>;
  listSessions(): Promise<Session[]>;
  getSession(id: SessionId): Promise<Session>;
  deleteSession(id: SessionId): Promise<void>;

  send(
    sessionId: SessionId,
    message: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<AgentEvent>;

  subscribe(
    sessionId: SessionId,
    opts?: { sinceEventId?: EventId },
  ): AsyncIterable<AgentEvent>;

  interrupt(sessionId: SessionId): Promise<void>;

  resolvePermission(
    sessionId: SessionId,
    requestId: string,
    decision: "allow" | "deny",
    remember?: RememberScope,
  ): Promise<void>;

  listRules(sessionId: SessionId): Promise<PermissionRule[]>;
  addRule(
    sessionId: SessionId,
    rule: PermissionRule,
    scope: "session" | "project",
  ): Promise<void>;

  // Skills and commands (server-hosted discovery; commands expand client-side)
  listSkills(sessionId: SessionId): Promise<Skill[]>;
  listCommands(sessionId: SessionId): Promise<Command[]>;

  // Subagent introspection (parent can walk the tree without knowing child URLs in advance)
  listSubagents(sessionId: SessionId): Promise<
    Array<{
      subagentId: string;
      sessionId: SessionId;
      url: string;
      purpose: string;
      status: string;
    }>
  >;
}
```

### 13.2 Iterator semantics

`send()` POSTs message, opens SSE, yields events until `run_finished`. If `permission_request` fires and no one resolves within a deadline (default 5min, configurable), client emits a synthetic `permission_timeout` event and iterator ends. SDK users watch for `permission_request` and call `resolvePermission()`.

Auto-reconnect with `sinceEventId` on transient network errors.

### 13.3 Why this is the SDK

TUI, outer agents, Slack harness — all consume the same `AsyncIterable<AgentEvent>` surface and handle permissions identically. No special cases.

## 14. TUI package (`@chimera/tui`)

Ink app. Consumes `ChimeraClient`. Handles slash-command expansion client-side before sending to server.

### 14.1 Layout

```
┌─ Chimera · <short-id> · <cwd> · <model> · [sandbox:overlay] ┐
│                                                              │
│ Message scrollback                                           │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ > Input box                                                  │
└─ Ctrl+C interrupt · Ctrl+D exit · / commands ────────────────┘
```

Subagent activity shows inline with a tree-style indent and a `[subagent: <purpose>]` header. Tapping (or `/attach <id>`) into a subagent opens its view as the active session.

### 14.2 Rendering rules

- Assistant text streams as it arrives
- Tool calls: collapsible, show `[sandbox]` or `[host]` badge
- Bash results: ~20 lines visible, expand affordance
- Skill activation: rendered as `📚 skill: <n>` indicator on the tool_call_start that triggered it
- Subagent events: nested block with collapsible child event stream
- Errors: red, prominent
- Minimal palette; respect `NO_COLOR`

### 14.3 Slash commands

The TUI recognizes two categories: **built-in commands** (hardcoded UI actions) and **user commands** (markdown templates from the commands registry).

**Built-in commands** (handled by TUI, never expanded or sent to model):

```
/help             list all commands (built-in + user)
/clear            clear scrollback (not history)
/new              new session
/sessions         list + switch
/exit             quit
/model            show/switch model
/rules            list active permission rules
/rules rm <n>     remove rule by index
/skills           list discovered skills
/attach <id>      attach to a running subagent
/subagents        list active subagents
/overlay          show overlay changes (overlay mode only)
/apply            apply overlay to host (overlay mode only)
/discard          discard overlay (overlay mode only)
```

**User commands** — anything else beginning with `/` is looked up in the commands registry. On match, the template is expanded with arg substitution (see §10) and sent as the user message. On miss, TUI shows "unknown command; did you mean…" with fuzzy matches.

### 14.4 Keybindings

- `Enter` send; `Shift+Enter` newline
- `Ctrl+C` interrupt; second press within 2s exits
- `Ctrl+D` exit
- Empty input `Up`/`Down`: history
- `PgUp`/`PgDn`: scroll scrollback
- `Tab` on partial `/` input: autocomplete command name
- `Tab` on partial `@` input: reserved for V2 (file mentions)

### 14.5 Permission prompt

Modal overlay; input keybinds scoped to prompt while active (see §8.5). When a permission_request arrives from a subagent (via `subagent_event`), the prompt renders with an extra header line identifying which subagent is asking.

## 15. CLI package (`@chimera/cli`)

### 15.1 Commands and flags

```
chimera                         Interactive session
chimera run "prompt"            One-shot
chimera run --stdin             Read prompt from stdin
chimera run --command <n> --args "..."  Run a slash command non-interactively
chimera serve                   Server only
chimera serve --machine-handshake       Emit JSON handshake on ready (for subagent spawn)
chimera attach <id|url>         TUI only
chimera ls                      List running instances (includes subagents)
chimera sessions                List persisted sessions
chimera sessions rm <id>
chimera skills                  List discovered skills
chimera commands                List discovered commands
chimera sandbox build           Build default image locally

Common flags:
  -m, --model <id>                     providerId/modelId (default from config)
  --cwd <path>                         working directory (default: process.cwd())
  --max-steps <n>                      agent loop cap (default 100)
  --session <id>                       resume session
  --sandbox                            enable sandbox
  --sandbox-mode bind|overlay|ephemeral
  --sandbox-strict                     refuse fallback
  --sandbox-image <ref>
  --sandbox-network none|host
  --sandbox-memory <size>
  --sandbox-cpus <n>
  --apply-on-success                   (overlay mode) auto-apply if run succeeded
  --auto-approve none|sandbox|host|all (default: sandbox if sandboxed, host if not)
  --max-subagent-depth <n>             default 3
  --no-subagents                       disable spawn_agent tool
  --no-skills                          skip skill discovery / index injection
  --no-claude-compat                   skip .claude/skills and .claude/commands discovery
  --json                               (run mode) NDJSON events to stdout
  --verbose, -v
  --quiet, -q

chimera serve:
  --port <n>                           override ephemeral port
  --host <addr>                        bind address (default 127.0.0.1; DO NOT change without auth)
  --machine-handshake                  emit single-line JSON on ready (see §12.5)
  --parent <sessionId>                 mark as subagent of given parent (metadata only)
```

### 15.2 Config file

`~/.chimera/config.json`:

```json
{
  "defaultModel": "anthropic/claude-opus-4-7",
  "providers": { ... },
  "sandbox": {
    "defaultMode": "bind",
    "image": "ghcr.io/<org>/chimera-sandbox:latest",
    "memory": "2g",
    "cpus": 2
  },
  "autoApprove": "sandbox",
  "skills": {
    "enabled": true,
    "claudeCompat": true
  },
  "commands": {
    "enabled": true,
    "claudeCompat": true
  },
  "subagents": {
    "enabled": true,
    "maxDepth": 3,
    "defaultInProcess": false
  }
}
```

Env vars override config. API keys via env preferred.

## 16. Cross-cutting concerns

### 16.1 Logging

- Structured JSON lines to `~/.chimera/logs/<date>.log`
- `--verbose` tees to stderr
- Never log API keys. Truncate tool args/results beyond ~4KB in logs.
- Permission decisions always logged with full detail.
- Subagent logs include `parent_session_id` field for trace reconstruction.

### 16.2 Error handling

- Model errors (rate limit, auth, network): exponential backoff, 3 retries, then `run_finished { reason: 'error' }`
- Tool errors: caught, surfaced as `tool_call_error`, fed back to model as tool result so it can recover
- Permission denials: returned to model as tool result `{ error: 'denied by user' }` so it can adapt
- Subagent errors: surfaced to parent via `spawn_agent` tool result; parent model can retry, decompose, or give up
- Unrecoverable: non-zero exit + actionable message

### 16.3 Testing

- `core`: unit tests for session state, event emission, interrupt, permission plumbing. Mock model client.
- `providers`: snapshot of message shapes per provider, stub HTTP.
- `tools`: LocalExecutor vs. temp dir, happy + error paths per tool.
- `permissions`: rule matching edge cases, storage round-trips, GatedExecutor pause/resume.
- `skills`: discovery path resolution (project/user/claude-compat), conflict handling, index generation, frontmatter parsing.
- `commands`: discovery, template expansion, placeholder substitution edge cases.
- `subagents`: child spawn + handshake, in-process mode, permission inheritance, nesting depth cap, interrupt cascade.
- `sandbox`: integration test with real Docker (gated on `CHIMERA_TEST_DOCKER=1`). Tests each mode. Overlay fallback path has its own gate.
- `server`: Hono test client for full request cycle including SSE.
- `client`: against a real server in a test harness.
- `tui`: ink-testing-library snapshots including command expansion and subagent rendering.
- E2E:
  - `chimera run "echo hello"` with stub model that deterministically calls bash once; covers sandboxed and non-sandboxed paths.
  - `chimera run --command review --args foo` expansion smoke test.
  - Parent spawning a real child subagent end-to-end (gated on `CHIMERA_TEST_E2E=1`).

### 16.4 Packaging

Published:

- `@chimera/core`, `@chimera/client`, `@chimera/tools`, `@chimera/providers`, `@chimera/sandbox`, `@chimera/permissions`, `@chimera/skills`, `@chimera/commands`, `@chimera/subagents` — SDK surface.
- `@chimera/cli` — installable binary: `npm i -g @chimera/cli` exposes `chimera`.

Internal (published for completeness, not advertised):

- `@chimera/tui`, `@chimera/server`.

## 17. Non-goals for V1

- MCP support
- Named subagent configs with auto-delegation (spawn_agent is generic in V1)
- In-process subagent mode as default (opt-in flag only)
- Plan mode
- Web UI
- User-scope permission rules (`~/.chimera/permissions.json`)
- Regex patterns for rules
- Encrypted credential storage / keychain
- Egress allowlists in sandbox
- Skill/command package manager (install from npm/git)
- Remote server deployment helpers
- Slack integration
- File mentions (`@path/to/file` in TUI input)

## 18. V2 preview (informs V1 decisions, not built now)

- Slack runner in `/apps/slack-runner`: webhook → provision cloud runner (Fly Machine / Vercel Sandbox) → `chimera serve --sandbox --auto-approve sandbox` → attach via `ChimeraClient` → stream to Slack thread → PR on completion. Host permission requests DM the invoker for out-of-band approval (via `--permission-prompt-via`).
- Bearer token auth on server.
- User-scope permission rules.
- Regex pattern support for rules.
- MCP support via a tool that proxies to an MCP server.
- Multi-session routing on a shared server.
- Named subagent configs: `.chimera/agents/<n>.md` with predefined tools, prompts, auto-delegation based on description (OpenCode-style).
- Skill/command ecosystem: `chimera skill add <npm-package|git-url>`.
- In-process subagent default with shared context option for tightly coupled fanout.

## 19. Build order

1. `@chimera/core` with stub executor and mock model — prove loop + events + permission pause/resume
2. `@chimera/providers` — real AI SDK wiring for both shapes
3. `@chimera/tools` + LocalExecutor — real tools
4. `@chimera/permissions` + GatedExecutor — permission flow end-to-end (still without sandbox)
5. `@chimera/skills` — discovery + index injection (validates with a stub skill)
6. `@chimera/commands` — discovery + expansion (validates with a stub command)
7. `@chimera/cli` with `chimera run` — first usable artifact
8. `@chimera/server` + `@chimera/client` — HTTP surface
9. `@chimera/tui` — interactive mode, slash-command handling, subagent rendering stubs
10. `@chimera/subagents` child-process mode — `spawn_agent` tool end-to-end
11. `@chimera/sandbox` bind mode — Docker basics
12. `@chimera/sandbox` overlay + ephemeral modes — full FS isolation
13. Polish: persistence, config, `ls`/`attach`, logs, sandbox fallback detection, subagent observability integration

Each step produces something runnable.

## 20. Open questions

- **Default model.** require the user to configure a provider
- **AGENTS.md walk stops where?** Nearest git root, else home dir? (Suggest: yes.)
- **Image distribution org.** Who owns the GHCR namespace? Needs a decision before publishing.
- **Overlay fallback behavior when `--sandbox-strict` is off.** Specified as "log warning, fall back to bind." OK? (Suggest: yes, with loud warning and docs link.)
- **Permission rule conflict resolution.** Deny wins, then longer pattern wins. Good enough for V1? (Suggest: yes; reassess with real usage.)
- **`chimera run` exit codes.** `0` = stop, `1` = error, `2` = max_steps, `130` = interrupted (SIGINT convention)? (Suggest: yes.)
- **Overlay and `.git`.** If cwd is a git repo, overlay captures `.git/` changes too. Usually what you want (commits in sandbox become real commits after apply). But `git gc` could churn overlay space. (Suggest: document, don't special-case in V1.)
- **`.chimera/` gitignore policy.** `.chimera/sessions/`, `.chimera/logs/` gitignored; `.chimera/permissions.json`, `.chimera/skills/`, `.chimera/commands/` committable. Recommend shipping a default `.gitignore` template.
- **Claude compat read depth.** When reading `.claude/skills/*/SKILL.md`, should we also honor Claude's nested subfolder conventions (e.g., SKILL.md references to other files via `see: ./scripts/foo.py`)? (Suggest: yes — just read the SKILL.md, let the model use `read` on referenced files like a human would.)
- **Subagent auto-approve default.** Child inherits parent's level. But should `all` or `host` automatically downgrade to `sandbox` for children unless explicitly passed? (Suggest: no — inheritance is least-surprise; users who want narrower child policies pass explicit flags to `spawn_agent`.)
- **Subagent timeout.** Default 10min too short for deep research? Too long? (Suggest: 10min, easily overridable per-call. The model picks based on `purpose`.)
- **Skill activation detection.** Currently inferred from path matching on `read` calls. Could be fooled by the model reading the file for other reasons. (Suggest: acceptable; the event is purely informational.)
