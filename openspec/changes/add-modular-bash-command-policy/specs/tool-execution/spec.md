## ADDED Requirements

### Requirement: Host bash policy routing
Every foreground and background host bash invocation, in native and Codex tool shapes, SHALL traverse the command-policy gate exactly once. Sandbox-target bash SHALL not traverse host path policy in this release.

#### Scenario: Foreground exact-once execution
- **WHEN** an approved foreground host command is issued
- **THEN** policy SHALL evaluate once and the executor SHALL run the original command once

#### Scenario: Background denial
- **WHEN** a background host command receives a denial
- **THEN** no background process SHALL be launched

### Requirement: Destructive commands use unified policy
The bash tool SHALL not maintain a parallel destructive-regex refusal path once equivalent policy coverage is present.

#### Scenario: Former hard-coded refusal
- **WHEN** a command matching a former destructive pattern is issued
- **THEN** it SHALL produce structured policy findings and follow the configured approval behavior
