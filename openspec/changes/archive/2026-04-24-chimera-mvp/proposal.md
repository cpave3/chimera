## Why

Chimera is specified at V1 scope (TUI + SDK + Docker sandbox + permissions + skills + commands + subagents) in `spec.md`, but that scope is too large to implement as a single change. We need a walking-skeleton MVP that proves the core thesis — **an SDK-first, TUI-second, permission-aware coding agent whose every consumer (TUI, subagents, future Slack harness) speaks the same event stream** — so we can then bolt on sandbox, skills, commands, and subagents as independent follow-on changes.

The MVP delivers a usable, interactive coding agent backed by a real HTTP+SSE SDK. Sandbox (Docker), skills, commands, and subagents are explicitly deferred to follow-on changes because each is a self-contained capability the agent functions without.

## What Changes

- Establish the pnpm + TypeScript + tsup + vitest + biome monorepo scaffolding and the strict dependency DAG from `spec.md` §3.
- Implement `@chimera/core`: session state, AI-SDK-based agent loop, typed `AgentEvent` stream, interrupt, permission-pause plumbing, session persistence to `~/.chimera/sessions/`.
- Implement `@chimera/providers`: shape-based provider registry (`anthropic`, `openai`) via `@ai-sdk/anthropic` / `@ai-sdk/openai`; `providerId/modelId` resolution; `env:VAR` key references.
- Implement `@chimera/tools`: the `Executor` interface, `LocalExecutor` (path-escape-safe), and built-in `bash` / `read` / `write` / `edit` tools defined with Zod schemas via the AI SDK `tool()` helper.
- Implement `@chimera/permissions`: `PermissionGate`, `GatedExecutor`, rule matching (exact + minimatch glob; deny-wins; longer-pattern-wins), session + project rule scopes (`./.chimera/permissions.json`), and `--auto-approve` tiers.
- Implement `@chimera/server`: Hono HTTP + SSE endpoints from `spec.md` §12 (sessions CRUD, messages, interrupt, permission resolve, rules, events stream with ring-buffer resume, `/v1/instance`, `/healthz`), bound to `127.0.0.1` only.
- Implement `@chimera/client`: typed `ChimeraClient` SDK — `createSession`, `send`, `subscribe`, `interrupt`, `resolvePermission`, rule management — with SSE auto-reconnect via `sinceEventId`.
- Implement `@chimera/tui`: Ink app consuming `ChimeraClient`, streaming rendering, permission modal, built-in slash commands (`/help`, `/clear`, `/new`, `/sessions`, `/exit`, `/model`, `/rules`), standard keybindings, `NO_COLOR` respect.
- Implement `@chimera/cli`: `chimera` (interactive), `chimera run` (one-shot, including `--stdin`, `--json` NDJSON), `chimera serve`, `chimera attach`, `chimera ls`, `chimera sessions`; flags from `spec.md` §15.1 limited to MVP scope (no sandbox, no subagent flags); `~/.chimera/config.json` loading; lockfile-based instance discovery under `~/.chimera/instances/`.
- Ship the "same-process server+TUI" architecture from `spec.md` §2.1: HTTP server always binds a real ephemeral port so any `chimera attach` or SDK client can connect to a running invocation.

## Capabilities

### New Capabilities

- `agent-core`: session state, agent loop over AI SDK `streamText`, typed event emission, interrupt, permission-pause latch, session persistence.
- `llm-providers`: shape-based (`anthropic` / `openai`) provider registry, `providerId/modelId` resolution, API-key resolution from env references.
- `tool-execution`: `Executor` interface, `LocalExecutor`, and the `bash` / `read` / `write` / `edit` built-in tools.
- `permissions`: permission model (auto-approve tiers, rule scopes, matching), `GatedExecutor` pause/resume, `./.chimera/permissions.json` persistence.
- `agent-server`: HTTP + SSE surface that exposes a single session per agent instance; ring-buffered event stream with resume.
- `agent-sdk`: typed `ChimeraClient` library that is the sole integration point for TUI and external consumers.
- `cli`: `chimera` binary and its subcommands, config file, instance lockfiles, machine-handshake reserved for future subagent use.
- `tui`: Ink-based interactive UI, permission modal, built-in slash commands, keybindings, streaming rendering.

### Modified Capabilities

None — this is the first change; `openspec/specs/` is empty.

## Impact

- **Code**: creates the entire `packages/` tree (core, providers, tools, permissions, server, client, cli, tui) plus root-level workspace configuration. No files in `packages/` are modified because none exist.
- **Runtime prerequisites**: Node.js ≥ 20, pnpm. No Docker requirement in the MVP — a later `add-sandbox` change introduces it.
- **External APIs**: requires an Anthropic-compatible or OpenAI-compatible endpoint to be configured; no key is bundled.
- **Filesystem**: creates `~/.chimera/{config.json,instances/,sessions/,logs/}` on first run and writes `./.chimera/permissions.json` when a project-scope rule is added.
- **Explicit non-goals for this change** (each is a future change, not rejected): Docker sandbox and overlay/ephemeral modes, `spawn_agent` / subagents, skills discovery and index injection, user-invoked slash-command templates, retrievable pruned tool outputs (`wishlist.md`), MCP, plan mode, web UI, keychain auth, Slack harness.
