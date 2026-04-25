# Chimera

Chimera is a terminal-native AI coding agent:

- **TUI-first** for interactive use (Ink-based).
- **SDK-first**: every consumer — the TUI, future Slack harnesses, future subagents — talks to the same `ChimeraClient` over HTTP + SSE, so there is no "side channel" behavior.
- **Permission-aware**: every shell call that would leave the agent's controlled scope is gated. Rules can be remembered session- or project-wide.
- **Shape-based providers**: any OpenAI-compatible or Anthropic-compatible endpoint works via `baseUrl` + `apiKey`.

Subagents and MCP are intentionally **not** in this release; each is a self-contained follow-on change. Docker sandbox, skills, and user-defined slash commands are in.

## Install

```
pnpm install
pnpm -r build
```

The CLI is exposed by `@chimera/cli`. During development, invoke it via:

```
node packages/cli/dist/bin.js <args>
```

## Configure a provider

Create `~/.chimera/config.json`:

```json
{
  "providers": {
    "anthropic": {
      "shape": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "env:ANTHROPIC_API_KEY"
    }
  },
  "defaultModel": "anthropic/claude-opus-4-7"
}
```

See `PROVIDERS.md` for known-good combinations including OpenRouter, local vLLM/Ollama, and Bedrock/Vertex proxies.

## Run

Interactive:

```
chimera
```

One-shot:

```
chimera run "run the test suite and fix any failures"
chimera run --json "list the top-level files" > events.ndjson
```

Start just the server (useful for attaching from another terminal):

```
chimera serve
chimera ls                     # show running instances
chimera attach <pid-or-url>    # future: mount TUI against a running instance
```

Session management:

```
chimera sessions
chimera sessions rm <session-id>
```

## Sandbox

Tool calls can be routed through a Docker container instead of running directly
on the host. Three modes are available:

- `bind` (default with `--sandbox`) — bind-mounts the cwd read-write into the
  container; writes land on the host immediately.
- `overlay` — bind-mounts the cwd read-only and stacks an overlayfs upperdir
  at `~/.chimera/overlays/<sessionId>/`. Writes go to the upperdir, then the
  user reviews and applies them at session end.
- `ephemeral` — like overlay but with a tmpfs upperdir. Nothing persists.

Examples:

```
# Run a one-shot prompt inside a bind-mount sandbox.
chimera run --sandbox "fix the failing tests"

# Apply changes from an overlay run iff the agent finished cleanly.
chimera run --sandbox --sandbox-mode overlay --apply-on-success "refactor X"

# Disable network access and tighten resources.
chimera run --sandbox --sandbox-network none --sandbox-memory 1g --sandbox-cpus 1 "..."

# Refuse to silently fall back to bind when overlay isn't supported.
chimera --sandbox --sandbox-mode overlay --sandbox-strict
```

In overlay mode, the TUI exposes `/overlay` (list pending changes), `/apply`
(interactive picker → rsync), and `/discard`.

The default image is `chimera-sandbox:dev`, built locally from
`packages/sandbox/docker/`. Pre-build it with `pnpm sandbox:build` (or
`chimera sandbox build`); otherwise the first `--sandbox` invocation
auto-builds it once. Pass `--sandbox-image <ref>` to use a different image
— there's no auto-build for non-default tags, so a typo errors immediately.

Overlay/ephemeral modes need `CAP_SYS_ADMIN` and `--security-opt
apparmor=unconfined` on `docker run`. See `SECURITY.md`.

## Filesystem layout

Chimera writes to:

- `~/.chimera/config.json` — read on startup.
- `~/.chimera/sessions/<sessionId>.json` — session snapshot on every step boundary.
- `~/.chimera/logs/<date>.log` — structured JSON-line activity log. API keys are never written.
- `~/.chimera/instances/<pid>.json` — lockfile for each running server process. Cleaned up on shutdown (and by `chimera ls` on next run).
- `./.chimera/permissions.json` — per-project permission rules (when the user picks "remember for project" in the modal).

See `docs/gitignore-template.md` for recommended `.gitignore` entries.

## Exit codes for `chimera run`

| Reason         | Code |
| -------------- | ---- |
| stop           | 0    |
| error          | 1    |
| max_steps      | 2    |
| interrupted    | 130  |

## What's not here (yet)

- No `spawn_agent` / subagents. The `--machine-handshake` flag on `chimera serve` is implemented for future subagent use but has no caller in MVP.
- No MCP.
- No bearer-token auth on the HTTP server. Bind is `127.0.0.1` only by default.

## Packages

```
packages/core          — agent loop, events, session persistence
packages/providers     — OpenAI/Anthropic-compat provider factories
packages/tools         — Executor, LocalExecutor, bash/read/write/edit
packages/permissions   — rule store, GatedExecutor, auto-approve tiers
packages/sandbox       — DockerExecutor, overlay diff/apply, sandbox image
packages/server        — Hono HTTP + SSE surface
packages/client        — typed TypeScript SDK (ChimeraClient)
packages/tui           — Ink-based interactive UI
packages/cli           — chimera binary
```

Dependency DAG is strict: `cli → tui, server, client, permissions, sandbox, tools, providers, core`. No back edges.
