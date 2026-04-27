# subagents Specification

## Purpose

The `@chimera/subagents` package exports the `spawn_agent` tool, which lets a
parent agent spawn a child agent — either as a separate `chimera serve`
process (default) or in-process. Children get their own permission gate,
their depth tracked against a configurable cap, and their event stream
re-emitted through the parent's `subagent_event` envelope so the parent's
TUI can render their work and resolve their permission prompts.

## Requirements

### Requirement: `spawn_agent` tool

`@chimera/subagents` SHALL export `buildSpawnAgentTool(ctx)` returning an AI-SDK `tool()` whose Zod schema accepts:

```
{
  prompt: string,
  purpose: string,
  cwd?: string,                     // default: parent cwd
  model?: string,                   // default: parent model
  tools?: string[],                 // default: ["bash","read","write","edit"]
  system_prompt?: string,
  sandbox?: boolean,                // default: inherit parent
  sandbox_mode?: "bind"|"overlay"|"ephemeral",
  timeout_ms?: number,              // default: 600000
  in_process?: boolean              // default: false
}
```

and returns:

```
{
  subagent_id: string,
  result: string,
  reason: "stop"|"max_steps"|"error"|"timeout"|"interrupted",
  session_id: string,
  steps: number,
  tool_calls_count: number,
  usage?: { inputTokens: number, outputTokens: number }
}
```

The tool MUST be registered only when `--no-subagents` is not set.

#### Scenario: Tool registration respects --no-subagents

- **WHEN** the CLI starts with `--no-subagents`
- **THEN** `buildTools(ctx)` SHALL NOT include `spawn_agent` in its returned record

#### Scenario: Default tool set for the child

- **WHEN** the parent model invokes `spawn_agent` without a `tools` field
- **THEN** the child Agent SHALL be constructed with exactly the built-ins `bash`, `read`, `write`, `edit` and SHALL NOT include `spawn_agent` unless `currentDepth + 1 < maxDepth`

### Requirement: Child-process lifecycle

When `in_process !== true`, `spawn_agent` SHALL:

1. Spawn `chimera serve --machine-handshake --cwd <cwd> --auto-approve <inherited> --parent <parentSessionId> [--sandbox ...]` via `child_process.spawn`.
2. Read exactly one newline-terminated JSON line from the child's stdout; parse it as `{ ready: true, url, sessionId, pid }`. The parent SHALL pass the parsed `sessionId` to its `subagent_spawned` event as `childSessionId` (renamed from `sessionId` to avoid collision with the envelope's parent-scoped `sessionId`).
3. Construct `new ChimeraClient({ baseUrl: url })`, emit a `subagent_spawned` event on the parent.
4. Call `client.send(sessionId, prompt)` and consume its `AsyncIterable<AgentEvent>`.
5. Re-emit every child event as a parent `subagent_event { subagentId, event }`.
6. On the child's terminal `run_finished`, extract the last `assistant_text_done.text` as `result`.
7. Call `client.deleteSession(sessionId)`, then SIGTERM the child process; SIGKILL after 2 s.
8. Emit `subagent_finished` on the parent and return the tool result object.

#### Scenario: Handshake timeout on broken child

- **WHEN** a spawned child process exits before emitting the handshake line, or emits an invalid JSON line
- **THEN** `spawn_agent` SHALL return `{ reason: "error", result: "<diagnostic>", ... }`, no `subagent_spawned` event SHALL be emitted, and the child process SHALL NOT remain running

#### Scenario: Event re-emission preserves order

- **WHEN** the child emits events E1, E2, E3 in that order before `run_finished`
- **THEN** the parent's event stream SHALL contain `subagent_event` wrappers for E1, E2, E3 in that same relative order (interleaving with parent events is allowed, but internal child order is preserved)

### Requirement: In-process mode

When `in_process === true`, `spawn_agent` SHALL bypass the child process entirely: construct `new Agent({...})` with a fresh `LocalExecutor`, a fresh `PermissionGate` (loaded with parent's project rules but holding its own session rules), and wire the parent's `AbortController` so `parent.interrupt()` cascades.

The child session SHALL NOT produce a lockfile, SHALL NOT appear in `chimera ls`, and SHALL NOT be attachable.

#### Scenario: In-process child not in ls

- **WHEN** the model invokes `spawn_agent` with `in_process: true` and the child is running
- **THEN** `chimera ls` in another terminal SHALL list only the parent's instance, not the child's

### Requirement: Depth enforcement

`buildSpawnAgentTool(ctx)` receives `currentDepth` and `maxDepth` (default `maxDepth = 3`). If `currentDepth >= maxDepth`, the tool SHALL return `{ reason: "error", result: "max subagent depth (<maxDepth>) reached" }` without spawning anything.

Children spawned successfully SHALL receive `currentDepth + 1` for their own tool context.

#### Scenario: Depth cap blocks nested spawn

- **WHEN** a parent at `currentDepth=2` with `maxDepth=3` invokes `spawn_agent` (creating depth 3 child), the depth-3 child then invokes `spawn_agent`
- **THEN** the depth-3 child's tool call SHALL return an error result naming the cap, and no further `chimera serve` process SHALL be spawned

### Requirement: Permission inheritance

By default, a spawned child SHALL inherit the parent's `AutoApproveLevel` and SHALL load the parent's project-scope permission rules file (`./.chimera/permissions.json` relative to the child's `cwd`).

If the parent process has no TTY (stdin is not a TTY) and the child raises a host-target permission request that is not satisfied by a rule, the child SHALL auto-deny it — the tool SHALL receive `{ error: "denied by user" }` and the child continues.

If the parent has a TTY, the child's `permission_request` SHALL surface through the `subagent_event` stream to the parent's TUI, which SHALL render it with a `[subagent: <purpose>]` header and resolve via the existing modal flow.

#### Scenario: Headless parent auto-denies child host permissions

- **WHEN** `chimera run "do X"` (non-TTY parent) calls `spawn_agent`, and the child then issues a `bash { target: "host" }` under `--auto-approve none`
- **THEN** the child's tool SHALL receive a denial result without prompting anywhere, and the run SHALL continue

#### Scenario: TTY parent renders child prompt

- **WHEN** an interactive parent session has an active child whose run produces a `permission_request`
- **THEN** the parent's TUI SHALL show a permission modal with the subagent's `purpose` in the header and the same six action keys; resolution SHALL be sent via `client.resolvePermission(childSessionId, ...)`

### Requirement: Interrupt cascade

When `Agent.interrupt()` is called on a parent whose `spawn_agent` tool is in flight, the tool implementation SHALL:

1. Call `client.interrupt(childSessionId)` to ask the child to abort cleanly.
2. Wait up to 5 s for the child to emit `run_finished { reason: "interrupted" }`.
3. Send SIGTERM to the child process (or invoke in-process `Agent.interrupt()` in in-process mode).
4. Send SIGKILL after another 2 s.

The parent's eventual `run_finished` SHALL have `reason: "interrupted"` and SHALL only be emitted after all children have cleaned up.

#### Scenario: Two children interrupted in parallel

- **WHEN** a parent has two simultaneous `spawn_agent` calls in flight (same turn, AI SDK parallel tool calls) and `Agent.interrupt()` is called
- **THEN** both children SHALL receive `client.interrupt` and subsequent SIGTERM; the parent's `run_finished` SHALL not fire until both children have exited or been SIGKILLed

### Requirement: Observability parity

Every successfully spawned child-process subagent SHALL:

- Write `~/.chimera/instances/<childPid>.json` via the standard CLI lockfile path, so `chimera ls` lists it with `parentId: <parentSessionId>`.
- Report `parentId` in `GET /v1/instance`.
- Be reachable via `chimera attach <childSessionId>` or direct URL.
- Include `subagent_of: <parent-session-id>` in every log line written to `~/.chimera/logs/`.

#### Scenario: `chimera attach` on a running child

- **WHEN** a child is mid-run and a user in a second terminal runs `chimera attach <childSessionId>`
- **THEN** the user SHALL see the child's live event stream rendered identically to a top-level session, including any currently pending permission prompt

#### Scenario: Subagent id is discoverable from the parent TUI

- **WHEN** a parent has one or more active child subagents and the user types `/subagents`
- **THEN** the parent's TUI SHALL display each active child's full `subagentId` alongside its `purpose`, `status`, and server `url`, so the user can copy the id and run `chimera attach <subagentId>` from another terminal
- **AND** every rendered `subagent_event` block in the parent's transcript SHALL include the subagent's id in its header label
