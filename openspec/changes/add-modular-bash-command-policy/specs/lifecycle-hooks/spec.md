## ADDED Requirements

### Requirement: Policy findings in PermissionRequest hook
The existing `PermissionRequest` hook SHALL receive optional provider-neutral policy analysis at the moment the gate would otherwise prompt. Automatically approved commands SHALL NOT fire this hook.

#### Scenario: Hook sees escalation reason
- **WHEN** a host command has risk, path, unresolved, or analyzer-error findings
- **THEN** the pre-prompt hook payload SHALL contain those findings before any permission event is emitted

#### Scenario: Hook blocks policy request
- **WHEN** the hook exits 2 for an enriched policy request
- **THEN** the command SHALL be denied without showing a user prompt
