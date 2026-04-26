# Lifecycle hooks

Chimera fires lifecycle hooks at five points in a session. A hook is just an executable file in a well-known directory: drop it in, it runs.

## Quick start

```sh
mkdir -p .chimera/hooks/PostToolUse
cat > .chimera/hooks/PostToolUse/audit.sh <<'SH'
#!/bin/sh
# Stdin is a JSON payload; env vars carry the basics.
echo "[$(date -u +%FT%TZ)] event=${CHIMERA_EVENT} session=${CHIMERA_SESSION_ID}" >> /tmp/chimera-audit.log
exit 0
SH
chmod +x .chimera/hooks/PostToolUse/audit.sh
```

`chimera hooks list` prints what's installed for the current cwd, including events with no scripts (so you can confirm names are recognized).

## Events

| Event              | When it fires                                                                 | Class |
|--------------------|--------------------------------------------------------------------------------|-------|
| `UserPromptSubmit` | A user message is accepted, before the model is invoked.                       | post  |
| `PostToolUse`      | A tool call completes (success or error).                                      | post  |
| `PermissionRequest`| The permission gate would otherwise prompt the user.                           | pre   |
| `Stop`             | An `Agent.run()` invocation ends.                                              | post  |
| `SessionEnd`       | A session is disposed by the server (shutdown, explicit close, etc.).          | post  |

## Discovery

Hooks live in two directories. Both are scanned on every event firing — drop a script and it picks up without a restart.

| Scope    | Path                                            |
|----------|-------------------------------------------------|
| Global   | `~/.chimera/hooks/<EventName>/`          |
| Project  | `<session-cwd>/.chimera/hooks/<EventName>/`     |

A "hook" is any regular file (or symlink to one) with at least one execute bit set. Within a directory, scripts run in lexicographic order. Across directories, all globals run before any project hooks.

## Inputs

Each hook receives a JSON payload on stdin. All payloads include `event`, `session_id`, and `cwd`. Per-event additions:

```jsonc
// UserPromptSubmit
{ "event": "UserPromptSubmit", "session_id": "...", "cwd": "...", "user_message": "..." }

// PostToolUse  (success)
{ "event": "PostToolUse", "session_id": "...", "cwd": "...",
  "tool_name": "bash", "tool_input": { ... }, "tool_result": { ... } }

// PostToolUse  (error)
{ "event": "PostToolUse", "session_id": "...", "cwd": "...",
  "tool_name": "bash", "tool_input": { ... }, "tool_error": "..." }

// PermissionRequest
{ "event": "PermissionRequest", "session_id": "...", "cwd": "...",
  "tool_name": "bash", "tool_input": { ... }, "target": "host", "command": "..." }

// Stop
{ "event": "Stop", "session_id": "...", "cwd": "...",
  "reason": "stop" /* | "max_steps" | "error" | "interrupted" */ }

// SessionEnd
{ "event": "SessionEnd", "session_id": "...", "cwd": "..." }
```

Three environment variables are also set, for scripts that prefer not to parse JSON:

```
CHIMERA_EVENT       e.g. PostToolUse
CHIMERA_SESSION_ID  the session's ULID
CHIMERA_CWD         the session's cwd
```

The hook's working directory at exec time is the session's `cwd`. The parent process's environment (including any vars its caller set, e.g. `LEGATO_TASK_ID`) passes through.

## Exit codes and outcomes

Events are classified as **pre** or **post**. Today only `PermissionRequest` is pre.

| Class | Exit 0  | Exit 2                                                                   | Other non-zero | Timeout (>30s) | Spawn failure |
|-------|---------|--------------------------------------------------------------------------|----------------|----------------|---------------|
| pre   | allow   | **block**: the call is denied without prompting; tool result is `denied by hook` | warning, allow | warning, allow | warning, allow |
| post  | ok      | warning                                                                   | warning        | warning        | warning        |

Pre-hooks **fail open** — a crashing or timing-out hook never blocks the agent. If you want strict denial on internal error, exit 2 explicitly inside your script.

When multiple `PermissionRequest` hooks are installed, the first one to exit 2 supplies the denial reason; remaining hooks still run to completion (their outputs are recorded but no longer change the outcome).

The 30-second timeout applies per script.

## Trust model

Any executable in the two directories runs with the agent's privileges, with no allowlist or signing check. Treat the directories the same way you'd treat `git` hooks: they're for your tooling, not for code shipped by untrusted third parties. If you check `.chimera/hooks/` into a repo, anyone running Chimera in that checkout will execute those scripts.

## Legato integration recipe

Legato (a kanban-style task tracker) integrates by dropping five scripts into `~/.chimera/hooks/<Event>/`. Each script is the same shape:

```sh
#!/bin/sh
# Generated by legato — do not edit manually.
# Only act inside Legato-spawned sessions.
[ -z "$LEGATO_TASK_ID" ] && exit 0
legato agent state "$LEGATO_TASK_ID" --activity working
exit 0
```

The activity value differs per event:

| Script path                                                       | Activity   |
|-------------------------------------------------------------------|------------|
| `~/.chimera/hooks/UserPromptSubmit/legato-prompt-submit.sh`| `working`  |
| `~/.chimera/hooks/PostToolUse/legato-post-tool-use.sh`     | `working`  |
| `~/.chimera/hooks/PermissionRequest/legato-permission.sh`  | `waiting`  |
| `~/.chimera/hooks/Stop/legato-stop.sh`                     | (clear)    |
| `~/.chimera/hooks/SessionEnd/legato-session-end.sh`        | (clear)    |

`LEGATO_TASK_ID` is set by Legato when it spawns Chimera in a tracked tmux pane; outside that environment the scripts are no-ops.
