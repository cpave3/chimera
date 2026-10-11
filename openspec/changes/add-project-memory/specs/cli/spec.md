## ADDED Requirements

### Requirement: Memory setting
`config.json` SHALL accept `memory.enabled` as a boolean. The default SHALL be `true`.

#### Scenario: Default
- **WHEN** the config has no `memory` key
- **THEN** sessions load the project memory
