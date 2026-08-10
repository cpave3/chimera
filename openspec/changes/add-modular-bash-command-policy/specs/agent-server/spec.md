## ADDED Requirements

### Requirement: Validated permission actions
The permission resolution endpoint SHALL validate discriminated allow, deny, deny-with-feedback, and allow-with-session-grant actions against the exact pending request.

#### Scenario: Grant persistence failure
- **WHEN** a proposed directory disappears or session metadata persistence fails
- **THEN** the endpoint SHALL return an error while leaving the permission pending and command unexecuted

#### Scenario: Already resolved request
- **WHEN** any action targets an already resolved request
- **THEN** the endpoint SHALL return 409 without mutation or feedback injection
