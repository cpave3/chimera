## ADDED Requirements

### Requirement: Shared host bash policy configuration
Interactive, run, serve, resumed, and child-agent construction SHALL use one validated `commandPolicy.hostBash` configuration. It SHALL default to enabled with `autoAllowThrough: "caution"`; accepted thresholds SHALL be none, safe, caution, and danger, with critical never auto-allowed.

#### Scenario: Invalid threshold
- **WHEN** config contains an unsupported host bash threshold
- **THEN** startup SHALL fail visibly with the config path and validation error

#### Scenario: Explicit rollback
- **WHEN** `commandPolicy.hostBash.enabled` is false
- **THEN** Chimera SHALL visibly use documented legacy behavior rather than silently disabling policy after an analyzer failure
