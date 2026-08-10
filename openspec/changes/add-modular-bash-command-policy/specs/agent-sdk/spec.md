## ADDED Requirements

### Requirement: Command policy transport
The SDK SHALL expose provider-neutral command-policy analysis and discriminated permission actions without requiring consumers to import the configured classifier.

#### Scenario: Resolve with feedback
- **WHEN** an SDK consumer denies a pending request with feedback
- **THEN** the client SHALL submit one atomic deny-with-feedback action

#### Scenario: Resolve with grant
- **WHEN** an SDK consumer accepts a valid grant proposal
- **THEN** the client SHALL submit the proposal identity, kind, and path with the allow action
