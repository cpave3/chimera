## Why

Chimera has no way for external tools to observe or react to its lifecycle. The immediate driver is Legato (the kanban-style task tracker), which integrates with Claude Code today by installing shell scripts that fire on prompt submission, tool use, permission requests, and session end — flipping a card's activity state between *working* / *waiting* / *idle*. For Legato to integrate with Chimera the same way, Chimera needs to fire equivalent events and run user-supplied scripts when they happen. The same mechanism unlocks future use cases (audit logging, project-local guards, telemetry sinks) without baking any of them into core.

## What Changes

- Add a lifecycle hook subsystem that discovers and executes user-supplied shell scripts when named events fire inside an agent session.
- Hook discovery is **directory-based** (Staccato-style): any executable file in `~/.chimera/hooks/<Event>/` (global) or `<project>/.chimera/hooks/<Event>/` (project) runs when `<Event>` fires. No config file edits required.
- Hooks receive a JSON payload on stdin and a small set of `CHIMERA_*` environment variables.
- Pre-events (currently just `PermissionRequest`) treat exit code 2 as a block; post-events treat exit code 2 as a warning. Other non-zero exits are warnings. 30-second timeout per script.
- Initial event set covers Legato's needs: `UserPromptSubmit`, `PostToolUse`, `PermissionRequest`, `Stop`, `SessionEnd`.
- Hooks fire from inside the Chimera **server** process (not the TUI). Failures are logged but do not abort the session.
- A `chimera hooks list` CLI command reports which hooks are discovered for the current project.

Out of scope for this change:
- No matcher syntax (e.g., `Bash(git *)`). Every script in an event directory runs for every occurrence of that event.
- No `http` / `prompt` / `agent` hook types. Only executable files.
- No `settings.json`-declared hooks. Directory drop-in is the only registration path.
- No plugin system. That is a separate, larger change.
- No mid-session hot-reload of hook directories.

## Capabilities

### New Capabilities

- `lifecycle-hooks`: directory-based hook discovery and execution that fires on named session lifecycle events; covers event taxonomy, payload schema, exit-code semantics, timeouts, and discovery rules.

### Modified Capabilities

- `permissions`: the `GatedExecutor` must call into the hook subsystem at the moment it would otherwise prompt the user, and honor an exit-code-2 block from a `PermissionRequest` hook.
- `cli`: a new `chimera hooks list` subcommand surfaces discovered hooks.

`agent-core` is not modified. The hook runner is a downstream consumer of the existing `AgentEvent` stream (`user_message` → `UserPromptSubmit`, `tool_call_result` → `PostToolUse`, `run_finished` → `Stop`); `SessionEnd` fires from the server's session-disposal path, not from the agent loop.

## Impact

- **New code**: a `packages/hooks` (or equivalent) module that owns directory discovery and script execution.
- **Touched code**:
  - `packages/permissions` — calls the hook runner at the would-prompt moment; respects block.
  - `packages/cli` — adds `hooks list` subcommand.
  - `packages/server` — wires the hook runner into the session lifecycle (subscribes to `AgentEvent`s, fires `SessionEnd` on session disposal).
  - `packages/core` — unchanged; existing `AgentEvent` stream is the input to the hook runner.
- **No TUI changes** — hooks run server-side only.
- **External impact**: enables Legato to ship a Chimera adapter that's a near-clone of its existing Staccato adapter (drop scripts in `.chimera/hooks/<Event>/`).
- **Security surface**: any executable file in the configured directories runs with the agent's privileges. Mitigations: restrict to two well-known locations, require executable bit, document the trust model. No managed-policy lockdown in this change — that lands later if needed.
- **Backward compatibility**: additive only. Existing sessions are unaffected if no hook directories exist.
