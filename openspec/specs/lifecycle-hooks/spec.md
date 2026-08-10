# lifecycle-hooks Specification

## Purpose

The lifecycle-hooks subsystem provides a directory-based hook system: users
drop executable scripts into well-known directories to react to session
lifecycle events (`SessionCreated`, `UserPromptSubmit`, `PostToolUse`,
`PermissionRequest`, `Stop`, `OnError`, `Timeout`, `Interrupt`, compaction, and
`SessionEnd`). Hooks run inside the `@chimera/server` process,
receive event payloads via stdin and environment variables, and — for
pre-events — can short-circuit the action by exiting with code 2.

## Requirements

### Requirement: Event taxonomy

The lifecycle-hooks subsystem SHALL define the following event names and fire each one at the corresponding point in a session's lifecycle:

- `SessionCreated` — fires when a fresh session is registered, but not when a persisted session is resumed.
- `UserPromptSubmit` — fires after a user message is accepted by the agent and before the model is invoked. Triggered by the `user_message` `AgentEvent`.
- `PostToolUse` — fires after a tool call completes (success or error). Triggered by the `tool_call_result` and `tool_call_error` `AgentEvent`s.
- `PermissionRequest` — fires inside the permission gate at the moment the gate would otherwise prompt the user. Triggered by `GatedExecutor`, **not** by the `permission_request` `AgentEvent`, so that an exit-code-2 block can short-circuit the prompt.
- `Stop` — fires when an `Agent.run()` reaches a clean stop, before any stop-hook retry. It does not fire for other terminal reasons.
- `OnError` — fires exactly once when a run terminates with `run_finished.reason: "error"`. The server registry awaits it before publishing that terminal event.
- `Timeout` — fires when a model response timeout terminates a run.
- `Interrupt` — fires when an active run is interrupted.
- `CompactionStart` — fires when session compaction begins.
- `CompactionEnd` — fires when session compaction succeeds or fails.
- `SessionEnd` — fires when a session is disposed by the server (e.g., process shutdown or explicit close). Triggered by the server's session-lifecycle code, not by the agent loop.

#### Scenario: PostToolUse fires after a successful bash call

- **WHEN** the model issues a bash tool call that completes successfully and a `PostToolUse` hook is installed
- **THEN** the hook script SHALL be invoked exactly once after the `tool_call_result` event for that call, with the tool name and result available in its stdin payload

#### Scenario: PermissionRequest fires before the user prompt, not via the event stream

- **WHEN** an ungated tool call reaches the permission gate, no rule matches, and a `PermissionRequest` hook is installed
- **THEN** the hook SHALL be invoked before the `permission_request` `AgentEvent` is emitted to consumers, and the user SHALL NOT be prompted until the hook exits

### Requirement: Directory-based discovery

Hooks SHALL be discovered at the moment of firing by listing two directories per event, in this order:

1. **Global**: `~/.chimera/hooks/<EventName>/`
2. **Project**: `<session.cwd>/.chimera/hooks/<EventName>/` (resolved relative to the session's `cwd` at session creation, not the runner process's `cwd`)

Within each directory, every entry that is (a) a regular file or symlink to a regular file and (b) has at least one execute bit set in its mode SHALL be treated as a hook. Non-executable files, directories, and broken symlinks SHALL be ignored.

When both directories yield hooks for the same event, all global hooks SHALL run before any project hooks. Within a single directory, hooks SHALL run in lexicographic order by filename. There SHALL be no other matcher, manifest, or filter — directory presence + execute bit is the only registration mechanism.

The subsystem SHALL NOT cache discovery results across firings; each event re-lists the directories.

#### Scenario: Drop-in script becomes active without restart

- **WHEN** an executable file is added to `<cwd>/.chimera/hooks/PostToolUse/` while a session is running and a tool call subsequently completes
- **THEN** the new hook SHALL run for that tool call without requiring the server or session to restart

#### Scenario: Non-executable file is ignored

- **WHEN** a file `<cwd>/.chimera/hooks/Stop/notes.md` exists with mode 0644 and the session ends
- **THEN** that file SHALL NOT be invoked and no error SHALL be raised

#### Scenario: Global hooks precede project hooks

- **WHEN** both `~/.chimera/hooks/UserPromptSubmit/audit` and `<cwd>/.chimera/hooks/UserPromptSubmit/audit` exist (each executable) and a user message is accepted
- **THEN** the global script SHALL run to completion before the project script is started

### Requirement: Hook payload and environment

Each hook invocation SHALL receive a single JSON object on stdin with these fields:

- `event`: the event name (one of the values in **Event taxonomy**).
- `session_id`: the session's ULID.
- `cwd`: the session's `cwd` at session creation.

For `SessionCreated`, the payload MAY additionally include `session_name: string`.

For `UserPromptSubmit`, the payload SHALL additionally include `user_message: string` (the message the user just submitted).

For `PostToolUse`, the payload SHALL additionally include `tool_name: string`, `tool_input: object`, and exactly one of `tool_result: any` (on success) or `tool_error: string` (on error).

For `PermissionRequest`, the payload SHALL additionally include `tool_name: string`, `tool_input: object`, `target: string`, and (if the request includes a `command`) `command: string`.

For `Stop`, the payload SHALL additionally include `reason: "stop"`.

For `OnError`, the payload SHALL additionally include `error: string`, containing the terminal run error or the stable fallback `"unknown"` when the `run_finished` event has no error value.

For `CompactionStart`, the payload SHALL additionally include `reason: string`.

For `CompactionEnd`, the payload SHALL additionally include `success: boolean` and SHALL include `error: string` when compaction fails with an error value.

For `Timeout`, `Interrupt`, and `SessionEnd`, no additional fields are required.

Each hook SHALL also receive these environment variables in addition to the parent process's environment:

- `CHIMERA_EVENT` — the event name.
- `CHIMERA_SESSION_ID` — the session's ULID.
- `CHIMERA_CWD` — the session's `cwd`.

The hook's working directory at exec time SHALL be the session's `cwd`.

The subsystem SHALL NOT pass any other channel — no command-line arguments, no temp files, no shared sockets.

#### Scenario: Hook reads payload from stdin and env

- **WHEN** a `PostToolUse` hook script runs after a bash tool call
- **THEN** stdin SHALL contain a JSON object with `event: "PostToolUse"`, `session_id`, `cwd`, `tool_name: "bash"`, `tool_input`, and either `tool_result` or `tool_error`; and `CHIMERA_EVENT=PostToolUse` SHALL be set in its environment

### Requirement: Exit-code semantics

The lifecycle-hooks subsystem SHALL classify each event as either **pre** or **post** and apply exit-code semantics accordingly:

- **Pre events**: `PermissionRequest`. Exit code 0 SHALL be treated as "allow"; exit code 2 SHALL be treated as "block" and SHALL cause the gate to deny the underlying tool call without prompting the user; any other non-zero exit SHALL be logged as a warning and treated as "allow" (fail-open).
- **Post events**: `SessionCreated`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `OnError`, `UserInputRequired`, `Timeout`, `Interrupt`, `CompactionStart`, `CompactionEnd`, `SessionEnd`. Any non-zero exit SHALL be logged as a warning and SHALL NOT alter session behavior.

When multiple hooks run for a single pre-event firing, the **first** hook to exit 2 SHALL block; subsequent hooks for that same firing SHALL still run to completion (their exit codes are recorded but no longer alter the outcome).

A blocked `PermissionRequest` SHALL surface to the model as `{ error: "denied by hook" }`, distinguishable from `{ error: "denied by user" }` and `{ error: "denied by rule" }`.

#### Scenario: Pre-hook block denies the tool

- **WHEN** a `PermissionRequest` hook exits with code 2 for a bash tool call
- **THEN** the user SHALL NOT see a permission prompt, the tool result delivered to the model SHALL be `{ error: "denied by hook" }`, and a `permission_resolved` event SHALL fire with `decision: "deny"` and `remembered: false`

#### Scenario: Post-hook non-zero exit is a warning

- **WHEN** a `PostToolUse` hook exits with code 1 after a successful tool call
- **THEN** the failure SHALL be logged at warning level and the session SHALL continue as if the hook had succeeded

#### Scenario: OnError completes before terminal publication

- **WHEN** a run yields `run_finished` with `reason: "error"` and `error: "terminated"`
- **THEN** the `OnError` hook SHALL run exactly once with `error: "terminated"` and complete or time out before the server publishes that terminal event to clients
- **AND** hook failure SHALL NOT replace, suppress, or change the original terminal event

#### Scenario: Non-error terminal reasons do not fire OnError

- **WHEN** a run finishes with `reason: "stop"`, `"max_steps"`, `"timeout"`, or `"interrupted"`
- **THEN** `OnError` SHALL NOT fire

### Requirement: Timeout

Each hook invocation SHALL be killed if it has not exited after 30 seconds. A timed-out hook SHALL be treated identically to a non-zero exit for its event class: for pre-events, fail-open (do not block); for post-events, log a warning. The 30-second limit SHALL apply per-script, not per-firing.

#### Scenario: Slow pre-hook does not block forever

- **WHEN** a `PermissionRequest` hook hangs and is killed at the 30-second timeout
- **THEN** the gate SHALL fall through to the user prompt as if the hook had exited 0 with a warning logged, and the session SHALL NOT be wedged

### Requirement: Hook execution failures do not abort the session

A hook that fails to start (e.g., permission denied after discovery race, missing interpreter, ENOENT) SHALL be logged at warning level and SHALL NOT cause the session to error out. Specifically, a hook execution failure SHALL NOT propagate as a `run_finished.reason: "error"`.

#### Scenario: Missing interpreter is logged, not fatal

- **WHEN** a hook script begins with `#!/missing/interpreter` and the kernel refuses to exec it
- **THEN** the failure SHALL be logged with the script path and underlying error, the event SHALL be treated as if the hook exited non-zero (warning for post-events, fail-open for pre-events), and the session SHALL NOT terminate

### Requirement: Hooks run inside the server process

The hook runner SHALL execute hooks from inside the `@chimera/server` process, not from inside the TUI process or from `@chimera/core`. The TUI SHALL NOT spawn hook scripts. `@chimera/core` SHALL NOT import the hook runner.

This requirement preserves the `agent-core` invariant that `AgentEvent`s are the sole observable surface from `@chimera/core`: the hook runner is a downstream consumer of that stream, not a parallel channel.

#### Scenario: TUI runs no hooks

- **WHEN** a user runs `chimera attach <id>` and connects only the TUI to a remote server
- **THEN** no hook scripts SHALL be invoked from the TUI process; all hook execution SHALL occur in the server process at the other end of the connection

### Requirement: User input required notification
The system SHALL discover observational `UserInputRequired` hooks and pass `{ event, session_id, cwd, request, kind? }` on stdin. The hook outcome SHALL be fail-open, and hook execution SHALL complete before the terminal waiting event is published.

#### Scenario: Notify before terminal completion
- **WHEN** an agent requests user input
- **THEN** every discovered `UserInputRequired` hook receives the actionable request
- **AND** clients receive `run_finished { reason: "waiting_for_input" }` only after hook completion
