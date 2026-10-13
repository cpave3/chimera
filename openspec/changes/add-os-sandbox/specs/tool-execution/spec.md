## ADDED Requirements

### Requirement: OS sandbox for host commands
With the OS sandbox active and no Docker sandbox, every host `bash` command, foreground or background, SHALL run inside the OS sandbox. Inside it the command SHALL be able to read every file, and SHALL be able to write only in the working directory, the temp directory, the session's granted write paths, the configured sandbox write paths, and the git directory of the working directory's repository when that directory is not below the working directory. `<cwd>/.chimera` and `~/.chimera` SHALL be read-only. With the network setting `off`, the command SHALL have no network access.

#### Scenario: Commit in a linked worktree
- **WHEN** the working directory is a linked git worktree and a sandboxed command runs `git commit`
- **THEN** the commit is made

#### Scenario: Write in the project
- **WHEN** a sandboxed command writes a file in the working directory
- **THEN** the file is written

#### Scenario: Write outside
- **WHEN** a sandboxed command writes a file in the user's home directory
- **THEN** the write fails and the file does not exist

#### Scenario: Own rules
- **WHEN** a sandboxed command writes `<cwd>/.chimera/hooks/PreToolUse/x.sh`
- **THEN** the write fails

#### Scenario: Network off
- **WHEN** the network setting is `off` and a sandboxed command opens a connection
- **THEN** the connection fails

### Requirement: Sandbox in the tool description
With the OS sandbox active, the `bash` tool description SHALL say where a command may write, that the network is off when it is, and that `unsandboxed: true` with a reason requests user approval or uses an explicit saved bypass rule. Without the OS sandbox, the description SHALL NOT mention it.

#### Scenario: Active
- **WHEN** a session's host commands run in the OS sandbox
- **THEN** the `bash` description names the working directory and `unsandboxed: true`

### Requirement: Sandbox in the system prompt
With the OS sandbox active, the session block of the system prompt SHALL name the sandbox as `os` and SHALL say where a bash command may write and how to ask for an unsandboxed run. The file-access rule SHALL say that a change outside the working directory and the temp directory needs an unsandboxed run. The prompt SHALL NOT say that there is no sandbox.

#### Scenario: Active
- **WHEN** a session starts with the OS sandbox active
- **THEN** its system prompt has the line `- sandbox: os — …` and names `unsandboxed: true`

### Requirement: Blocked command note
When a sandboxed command fails and its output shows that the sandbox refused a write, or refused the network while the network setting is `off`, and no automatic host retry is authorized, the tool result SHALL carry a note that says what the sandbox allows and how to ask for an unsandboxed run.

#### Scenario: Refused write
- **WHEN** a sandboxed command fails with `Read-only file system`
- **THEN** the tool result has a `sandbox` note that names `unsandboxed`

### Requirement: Automatic remembered bypass retry
Foreground and background bash calls SHALL retry a recognized OS sandbox failure on the host once when a fresh, non-prompting policy check admits an explicit saved exact/prefix bypass rule. Deny rules, hard blocks, sudo authentication and other mandatory findings SHALL retain precedence. Ordinary/glob allow rules, auto-approval and AI reviewers SHALL NOT authorize retries. Normal command failures, timeouts and cancellations SHALL NOT be retried. Results SHALL retain visible `sandbox_retry` evidence and original diagnostics. Foreground retries SHALL share the original timeout budget; background retries SHALL retain the shell ID and prevent relaunch after cancellation, including cancellation during authorization. A retry may repeat partial side effects from the first attempt; documentation SHALL warn of this risk.

#### Scenario: Registered tool retries a protected write
- **WHEN** a sandboxed registered bash call fails writing a protected path and an explicit saved bypass rule matches
- **THEN** it retries once on the host without a prompt or another model call, returns retry evidence, and the authorized write succeeds

#### Scenario: Mandatory finding prevents retry
- **WHEN** a saved bypass rule matches but a fresh policy check finds another mandatory approval requirement
- **THEN** the sandbox failure is returned without a host retry or an approval prompt

#### Scenario: Polling a background retry
- **WHEN** a background command's stderr is consumed before it exits and its sandbox failure is authorized for retry
- **THEN** retry classification still uses the first attempt's stderr, and subsequent polls retain retry metadata under the same shell ID

### Requirement: Unsandboxed request
`bash` SHALL accept `unsandboxed: true`, which runs the command outside the OS sandbox. Such a call SHALL carry a `reason` and SHALL need approval unless an explicit exact/prefix bypass rule admits it under the permission policy. Auto-approval and ordinary allow rules SHALL NOT grant a bypass. With no user to ask and no bypass rule, it SHALL be denied. Both native and Codex-shaped bash schemas SHALL retain the unsandboxed argument and reason.

#### Scenario: Approved
- **WHEN** the model calls `bash` with `unsandboxed: true` and a reason, and the user allows it
- **THEN** the command runs outside the sandbox

#### Scenario: No reason
- **WHEN** the model calls `bash` with `unsandboxed: true` and no reason
- **THEN** the command does not run, and the result asks for a reason

#### Scenario: Auto-approval does not apply
- **WHEN** auto-approve is `all`, no explicit bypass rule matches, and the model calls `bash` with `unsandboxed: true`
- **THEN** the user is asked

#### Scenario: Codex tool surface
- **WHEN** a Codex-shaped bash call supplies `unsandboxed: true` and a reason
- **THEN** both fields reach the native bash execution and permission gate

#### Scenario: Tool-surface update takes effect
- **WHEN** a tool-surface fix is built and Chimera is restarted with a new session
- **THEN** the new session receives the updated tool definitions; rebuilding alone does not change a running session's schemas

### Requirement: Protected paths for the file tools
While the OS sandbox is active, the file tools SHALL refuse to write `<cwd>/.chimera/permissions.json` and any path under `<cwd>/.chimera/hooks/`.

#### Scenario: Rule file
- **WHEN** the model calls `write` on `.chimera/permissions.json`
- **THEN** the call fails and the file is unchanged
