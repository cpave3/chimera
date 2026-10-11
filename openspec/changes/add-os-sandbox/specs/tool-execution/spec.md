## ADDED Requirements

### Requirement: OS sandbox for host commands
With the OS sandbox active and no Docker sandbox, every host `bash` command, foreground or background, SHALL run inside the OS sandbox. Inside it the command SHALL be able to read every file, and SHALL be able to write only in the working directory, the temp directory, the session's granted write paths and the configured sandbox write paths. `<cwd>/.chimera` and `~/.chimera` SHALL be read-only. With the network setting `off`, the command SHALL have no network access.

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

### Requirement: Blocked command note
When a sandboxed command fails and its output shows that the sandbox refused a write, or refused the network while the network setting is `off`, the tool result SHALL carry a note that says what the sandbox allows and how to ask for an unsandboxed run.

#### Scenario: Refused write
- **WHEN** a sandboxed command fails with `Read-only file system`
- **THEN** the tool result has a `sandbox` note that names `unsandboxed`

### Requirement: Unsandboxed request
`bash` SHALL accept `unsandboxed: true`, which runs the command outside the OS sandbox. Such a call SHALL carry a `reason` and SHALL need the user's approval, whatever the auto-approve level and the allow rules are. With no user to ask, it SHALL be denied.

#### Scenario: Approved
- **WHEN** the model calls `bash` with `unsandboxed: true` and a reason, and the user allows it
- **THEN** the command runs outside the sandbox

#### Scenario: No reason
- **WHEN** the model calls `bash` with `unsandboxed: true` and no reason
- **THEN** the command does not run, and the result asks for a reason

#### Scenario: Auto-approval does not apply
- **WHEN** auto-approve is `all` and the model calls `bash` with `unsandboxed: true`
- **THEN** the user is asked

### Requirement: Protected paths for the file tools
While the OS sandbox is active, the file tools SHALL refuse to write `<cwd>/.chimera/permissions.json` and any path under `<cwd>/.chimera/hooks/`.

#### Scenario: Rule file
- **WHEN** the model calls `write` on `.chimera/permissions.json`
- **THEN** the call fails and the file is unchanged
