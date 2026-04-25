# Chimera

Chimera is a terminal-native AI coding agent:

- **TUI-first** for interactive use (Ink-based).
- **SDK-first**: every consumer — the TUI, future Slack harnesses, future subagents — talks to the same `ChimeraClient` over HTTP + SSE, so there is no "side channel" behavior.
- **Permission-aware**: every shell call that would leave the agent's controlled scope is gated. Rules can be remembered session- or project-wide.
- **Shape-based providers**: any OpenAI-compatible or Anthropic-compatible endpoint works via `baseUrl` + `apiKey`.

MCP is intentionally **not** in this release; it's a self-contained follow-on change. Docker sandbox, skills, user-defined slash commands, and subagents (`spawn_agent`) are in.

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

## Subagents

The `spawn_agent` tool lets a parent agent delegate a focused task to a fresh
Chimera instance. By default subagents run as a separate `chimera serve`
process so they show up in `chimera ls` and are observable from another
terminal — see [SUBAGENTS.md](./SUBAGENTS.md) for the full debugging workflow.

```
# Cap nesting at 5 levels (default 3).
chimera --max-subagent-depth 5

# Disable the spawn_agent tool entirely for a session.
chimera --no-subagents
```

## Tool scrollback formatting

Tools render in the scrollback as concise summaries instead of raw JSON args:

```
[host] read: src/foo.ts:12-40 (87 lines)
[host] edit: src/foo.ts (3 replacements)
[host] bash: pnpm build (exit 0)
[host] write: next.config.ts (created, 412 bytes)
```

Each built-in tool ships with a `formatScrollback` hook in its definition
that produces an args-only summary at call start and a result-aware summary
once the tool returns. Plugin tools authored via `defineTool` from
`@chimera/tools` opt in by passing `formatScrollback`; tools without one
fall back to the original `<name> <truncated-JSON>` rendering.

## Token usage

The TUI's status bar shows live token usage and the percentage of the model's
context window consumed by the latest step. The number comes from the AI SDK's
`usage` payload — no estimation, no extra calls. Cumulative totals persist
with the session, so resuming an old session shows the same running counter
on the next prompt.

Color escalates as the prompt fills the window: gray under 80%, amber from
80–95%, red at 95% or above. The window itself is resolved from a built-in
table for known Claude / GPT / o-series models. To override (or add a model
we don't know about yet), set a `models` block in `~/.chimera/config.json` —
see `PROVIDERS.md`.

## What's not here (yet)

- No MCP.
- No bearer-token auth on the HTTP server. Bind is `127.0.0.1` only by default.

## Theme Customization

The TUI loads a user theme from `~/.chimera/theme.json`, alongside the rest of Chimera's user state (sessions, config, logs). Create the file to override any subset of the default colour tokens:

```json
{
  "accent": {
    "primary": "green",
    "secondary": "cyanBright"
  },
  "status": {
    "error": "redBright"
  },
  "text": {
    "muted": "gray"
  }
}
```

Only specify the tokens you want to override; the rest inherit from the default theme. Available token groups:

- `base` — `foreground`, `background`
- `accent` — `primary`, `secondary`, `tertiary`
- `status` — `success`, `warning`, `error`, `info`
- `text` — `primary`, `secondary`, `muted`
- `ui` — `badge`, `accent`

JSON has no native comments, so the loader strips unknown top-level keys — you can leave a `_comment` field in the file as a note. If the JSON is malformed, the TUI prints `theme: ...` on stderr at startup and falls back to the default theme.

See `docs/theme.json.example` for an annotated partial-override sample, or `docs/theme-dracula.json` for a full re-skin.

### Switching between themes

The TUI ships a few bundled presets: `default`, `tokyo-night-moon`, and `cyberpunk`. From inside the TUI:

- `/theme` — list available themes; the active one is marked with a leading `*`.
- `/theme <name>` — write the chosen preset into `~/.chimera/theme.json` (with a `_themeName` marker so `/theme` can show which is active) and live-reload without restarting.

Drop additional partial themes into `~/.chimera/themes/<name>.json` to extend the list; user files shadow bundled presets of the same name. Hand-edits to `~/.chimera/theme.json` always take effect on next start, but running `/theme <name>` overwrites them.

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
