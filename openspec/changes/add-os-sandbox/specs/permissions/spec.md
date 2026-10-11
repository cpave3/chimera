## ADDED Requirements

### Requirement: Path findings in the OS sandbox
For a host command that will run in the OS sandbox, the permission gate SHALL NOT ask for approval because of path findings. Elevation, risk, blocked and analyzer-error findings SHALL act as they do without the sandbox. A command approved with a sudo finding SHALL run outside the sandbox.

#### Scenario: Path finding only
- **WHEN** a sandboxed command has one finding, a write outside the authorized directories
- **THEN** the command runs with no prompt, inside the sandbox

#### Scenario: Risk finding
- **WHEN** a sandboxed command has a `danger` risk finding
- **THEN** the user is asked, as without the sandbox

### Requirement: Approval of an unsandboxed run
A request to run a command outside the OS sandbox SHALL be approval-required: neither the auto-approve level nor an allow rule SHALL admit it. Without an approval reviewer the gate SHALL ask the user and SHALL show the model's reason, and SHALL deny the request in a headless session. A deny rule that matches SHALL deny it without a prompt. The decision SHALL be written to the decision audit log.

#### Scenario: Allow rule does not apply
- **WHEN** an allow rule matches the command and the request is for an unsandboxed run
- **THEN** the user is asked

#### Scenario: Headless
- **WHEN** the session auto-denies prompts and the request is for an unsandboxed run
- **THEN** the request is denied
