## ADDED Requirements

### Requirement: PreToolUse hook
Chimera SHALL fire a `PreToolUse` hook before each tool call and wait for it. The payload SHALL carry `tool_name` and `tool_input`. `PreToolUse` SHALL be a pre-class event: exit code 2, or exit code 0 with a JSON `{"decision": "block"}` on stdout, SHALL block the call. A blocked call SHALL NOT run, and the model SHALL get a tool error that holds the hook's reason. Any other outcome of the hook (another exit code, a timeout, a failure to start) SHALL allow the call and SHALL be logged as a warning. The hook SHALL NOT be able to change the tool input.

#### Scenario: Allow
- **WHEN** a `PreToolUse` hook exits 0 for a `read` call
- **THEN** the call runs and returns its result

#### Scenario: Block
- **WHEN** a `PreToolUse` hook exits 2 with `no writes to migrations/` on stderr for a `write` call
- **THEN** the file is not written, and the model gets a tool error that contains `no writes to migrations/`

#### Scenario: Block with JSON
- **WHEN** a `PreToolUse` hook prints `{"decision":"block","reason":"frozen"}` and exits 0
- **THEN** the call does not run, and the tool error contains `frozen`

#### Scenario: Timeout
- **WHEN** a `PreToolUse` hook runs longer than the hook timeout
- **THEN** the call runs

#### Scenario: Before the permission gate
- **WHEN** a `PreToolUse` hook blocks a `bash` call that would need approval
- **THEN** no permission prompt opens
