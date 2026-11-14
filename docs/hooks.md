# Lifecycle hooks

Chimera supports lifecycle hooks at session and agent events. A hook is just an executable file in a well-known directory: drop it in, it runs.

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
| `SessionCreated`   | A fresh session is registered; it does not fire when resuming a session.        | post  |
| `UserPromptSubmit` | A prompt or continuation is accepted (with its source).                       | post  |
| `PreToolUse`       | A tool call is about to run, before the permission gate.                       | pre   |
| `PostToolUse`      | A tool call completes (success or error).                                      | post  |
| `PermissionRequest`| The permission gate would otherwise prompt the user.                           | pre   |
| `PermissionResolved`| A human or automated permission decision completes, before work resumes.      | post  |
| `Stop`             | A run stops cleanly or reaches max_steps / output_limit.                         | post  |
| `OnError`          | A run terminates with `run_finished.reason: "error"`.                          | post  |
| `UserInputRequired`| The agent requests human assistance and ends its current run.                    | post  |
| `Timeout`          | A model response times out.                                                     | post  |
| `Interrupt`        | An active run is interrupted.                                                   | post  |
| `CompactionStart`  | Session compaction begins.                                                      | post  |
| `CompactionEnd`    | Session compaction succeeds or fails.                                           | post  |
| `SessionEnd`       | A session is disposed by the server (shutdown, explicit close, etc.).           | post  |

## Discovery

Hooks live in two directories. Both are scanned on every event firing — drop a script and it picks up without a restart.

| Scope    | Path                                            |
|----------|-------------------------------------------------|
| Global   | `~/.chimera/hooks/<EventName>/`          |
| Project  | `<session-cwd>/.chimera/hooks/<EventName>/`     |

A "hook" is any regular file (or symlink to one) with at least one execute bit set. Within a directory, scripts run in lexicographic order. Across directories, all globals run before any project hooks.

## Inputs

Each hook receives one JSON payload on stdin. All payloads include `event`, `session_id`, and `cwd`. Scripts can parse stdin for event-specific fields and use `CHIMERA_SESSION_ID` directly when they only need the session ID. Per-event additions:

```jsonc
// SessionCreated (session_name is optional)
{ "event": "SessionCreated", "session_id": "...", "cwd": "...", "session_name": "..." }

// UserPromptSubmit
{ "event": "UserPromptSubmit", "session_id": "...", "cwd": "...", "user_message": "...", "source": "user" }

// PreToolUse
{ "event": "PreToolUse", "session_id": "...", "cwd": "...",
  "tool_name": "write", "tool_input": { "path": "migrations/1.sql", "content": "..." } }

// PostToolUse  (success)
{ "event": "PostToolUse", "session_id": "...", "cwd": "...",
  "tool_name": "bash", "tool_input": { ... }, "tool_result": { ... } }

// PostToolUse  (error)
{ "event": "PostToolUse", "session_id": "...", "cwd": "...",
  "tool_name": "bash", "tool_input": { ... }, "tool_error": "..." }

// PermissionRequest (policy_analysis is present for host bash escalations)
{ "event": "PermissionRequest", "session_id": "...", "cwd": "...",
  "tool_name": "bash", "tool_input": { ... }, "target": "host", "command": "...",
  "policy_analysis": {
    "version": 1,
    "outcome": "approval_required",
    "stages": [{ "id": "risk", "status": "findings", "findings": [] }],
    "findings": [{ "kind": "risk", "stageId": "risk", "level": "danger",
      "score": 80, "message": "destructive command" }]
  } }

// PermissionResolved (human or automated decisions)
{ "event": "PermissionResolved", "session_id": "...", "cwd": "...",
  "request_id": "...", "decision": "allow", "remembered": false,
  "session_status": "running", "remaining_pending": 0 }

// Stop (reason: stop, max_steps, or output_limit)
{ "event": "Stop", "session_id": "...", "cwd": "...", "reason": "stop" }

// OnError
{ "event": "OnError", "session_id": "...", "cwd": "...", "error": "terminated" }

// UserInputRequired (kind is optional: "information" or "action")
{ "event": "UserInputRequired", "session_id": "...", "cwd": "...",
  "request": "Run X and paste the output", "kind": "action" }

// Timeout / Interrupt
{ "event": "Timeout", "session_id": "...", "cwd": "..." }
{ "event": "Interrupt", "session_id": "...", "cwd": "..." }

// CompactionStart / CompactionEnd
{ "event": "CompactionStart", "session_id": "...", "cwd": "...", "reason": "manual" }
{ "event": "CompactionEnd", "session_id": "...", "cwd": "...", "success": true }
{ "event": "CompactionEnd", "session_id": "...", "cwd": "...",
  "success": false, "error": "..." }

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

Events are classified as **pre** or **post**. `PreToolUse` and `PermissionRequest` are pre.

| Class | Exit 0  | Exit 2                                                                   | Other non-zero | Timeout (>30s) | Spawn failure |
|-------|---------|--------------------------------------------------------------------------|----------------|----------------|---------------|
| pre   | allow   | **block**: the call is denied without prompting; tool result is `denied by hook` | warning, allow | warning, allow | warning, allow |
| post  | ok      | warning                                                                   | warning        | warning        | warning        |

A blocked `PreToolUse` call does not run. The model gets the tool error `blocked by PreToolUse hook: <reason>`, where the reason is the script's stderr, or the `reason` of a JSON `{"decision": "block"}` on stdout. `PreToolUse` runs for every tool (built-in, MCP, `spawn_agent`) and comes before the permission gate, so a blocked call opens no prompt. The hook sees the tool's input and cannot change it.

```sh
#!/bin/sh
# .chimera/hooks/PreToolUse/no-migrations.sh — keep the agent out of migrations/.
payload=$(cat)
case "$payload" in
  *'"tool_name":"write"'*migrations/* | *'"tool_name":"edit"'*migrations/*)
    echo "migrations/ is frozen; write a new migration by hand" >&2
    exit 2 ;;
esac
exit 0
```

Pre-hooks **fail open** — a crashing or timing-out hook never blocks the agent. If you want strict denial on internal error, exit 2 explicitly inside your script.

`OnError`, `UserInputRequired`, and `PermissionResolved` are observational. A failed resolution hook cannot prevent the permission decision from taking effect. Chimera waits for `PermissionResolved` after recomputing permission state but before resuming work, so external state changes are ordered before resumed work. With multiple requests, `session_status` remains `waiting_for_permission` and `remaining_pending` stays nonzero until the final request resolves; the final resolution reports `running` and zero. Permission resolution never reports `idle` because allow and deny both continue the turn. A later terminal hook reports its actual outcome.

`PermissionResolved` also fires when a request completes without a human prompt: System One or reviewer approvals, including automatic host retries, and hook, headless, or policy denials. This balances request hooks even when no interactive request was raised. A policy block can emit resolution without a preceding request hook. Automated completions use the same resolution queue and report the count of genuine pending permissions; they do not clear another request. Immediate rule matches and trusted or auto-approved calls that skip request hooks do not fire this lifecycle hook.

Chimera waits for `OnError` and `UserInputRequired` to complete (or reach the per-script timeout) before publishing `run_finished` to clients. Timeout and interrupt completions use their dedicated events instead.

When multiple `PermissionRequest` hooks are installed, the first one to exit 2 supplies the denial reason; remaining hooks still run to completion (their outputs are recorded but no longer change the outcome).

The 30-second timeout applies per script.

## Trust model

Any executable in the two directories runs with the agent's privileges, with no allowlist or signing check. Treat the directories the same way you'd treat `git` hooks: they're for your tooling, not for code shipped by untrusted third parties. If you check `.chimera/hooks/` into a repo, anyone running Chimera in that checkout will execute those scripts.

## Legato integration recipe

Legato (a kanban-style task tracker) integrates by dropping scripts into `~/.chimera/hooks/<Event>/`. For example, `~/.chimera/hooks/SessionCreated/legato-session-created.sh` can capture the ID assigned by Chimera for later orchestration:

```sh
#!/bin/sh
# Generated by legato — do not edit manually.
[ -z "$LEGATO_TASK_ID" ] && exit 0
payload=$(cat)
printf '%s\n' "$payload" > "$LEGATO_STATE_DIR/session-created.json"
printf '%s\n' "$CHIMERA_SESSION_ID" > "$LEGATO_STATE_DIR/chimera-session-id"
```

Other event scripts can update orchestrator state directly:

```sh
#!/bin/sh
[ -z "$LEGATO_TASK_ID" ] && exit 0
exec legato agent state "$LEGATO_TASK_ID" --activity working
```

The activity value differs per event:

| Script path                                                       | Activity   |
|-------------------------------------------------------------------|------------|
| `~/.chimera/hooks/SessionCreated/legato-session-created.sh` | (capture)  |
| `~/.chimera/hooks/UserPromptSubmit/legato-prompt-submit.sh`| `working`  |
| `~/.chimera/hooks/PermissionRequest/legato-permission.sh`  | `waiting`  |
| `~/.chimera/hooks/PermissionResolved/legato-permission-resolved.sh` | payload-dependent |
| `~/.chimera/hooks/Stop/legato-stop.sh`                     | (clear)    |
| `~/.chimera/hooks/SessionEnd/legato-session-end.sh`        | (clear)    |

The resolution script maps `waiting_for_permission` with pending requests to `waiting`, and `running` with zero pending requests to `working`. `PostToolUse` is deliberately not an activity transition: parallel tool results can arrive while another permission is still outstanding and must not overwrite `waiting`. Terminal hooks such as `Stop`, `Interrupt`, `Timeout`, and `SessionEnd` clear the activity after the resumed turn actually ends.

`LEGATO_TASK_ID` is set by Legato when it spawns Chimera in a tracked tmux pane; outside that environment the scripts are no-ops. Re-run `legato hooks install --tool chimera` after upgrading Legato to install the resolution hook and remove its obsolete managed `PostToolUse` script.

### Lifecycle ordering

Shell hooks and mods consume one process-wide lifecycle source. Within a session,
`UserPromptSubmit`, `PostToolUse`, and `CompactionStart`/`CompactionEnd` run in a
serial queue without making the agent loop wait for them. Later awaited hooks,
including `Stop`, wait for earlier scripts to finish. Different sessions do not
hold each other up.

`UserPromptSubmit.source` is `user`, `continuation`, `background`, `stop_retry`,
or `goal`. `Stop.reason` is `stop`, `max_steps`, or `output_limit`; only a clean
`stop` may be blocked to request a retry. Limit stops are notifications.
