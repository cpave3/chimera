## ADDED Requirements

### Requirement: Goal settings
The config SHALL accept `goal.maxContinuations`, a positive whole number with the default 20. The goal checker SHALL call the `utilityModel`, or the session's model when no `utilityModel` is set. A subagent session SHALL have no goal checker.

#### Scenario: Default
- **WHEN** the config has no `goal`
- **THEN** a run continues at most 20 times for a goal that is not met

### Requirement: Goal of a headless run
`chimera run --goal "<condition>"` SHALL set the goal before the run starts. The exit code SHALL be 0 when the goal is met, 2 when the run ends at the continuation limit, 3 when the goal is not possible, and 1 when the check failed. Without `--goal` the exit codes SHALL be as before.

#### Scenario: Met
- **WHEN** the checker answers `met`
- **THEN** `chimera run --goal` exits with 0

#### Scenario: Limit
- **WHEN** the run ends at the continuation limit
- **THEN** `chimera run --goal` exits with 2

#### Scenario: Not possible
- **WHEN** the checker answers `impossible`
- **THEN** `chimera run --goal` exits with 3
