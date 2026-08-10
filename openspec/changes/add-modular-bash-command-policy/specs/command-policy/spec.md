## ADDED Requirements

### Requirement: Ordered host command policy pipeline
The system SHALL evaluate each agent-issued host bash command through ordered provider-neutral policy stages exactly once before legacy permission approval. Stage failures SHALL produce mandatory analyzer-error findings rather than bypassing policy.

#### Scenario: Passing safe command
- **WHEN** all stages pass and normalized risk is at or below the configured threshold
- **THEN** the command SHALL proceed to legacy permission policy with no mandatory finding

#### Scenario: Failed stage
- **WHEN** a mandatory stage times out, throws, or returns malformed evidence
- **THEN** the system SHALL require approval with an analyzer-error finding and SHALL deny headless execution

### Requirement: Conservative shell effects and path authorization
The system SHALL infer read, write, and delete effects for supported literal Bash operands and authorize them against canonical effective roots. Unsupported or dynamic effects SHALL be unresolved and SHALL NOT auto-execute.

#### Scenario: Unauthorized write
- **WHEN** a literal write target is outside effective write roots
- **THEN** policy SHALL identify the write operation and canonical target in a mandatory path finding

#### Scenario: Dynamic target
- **WHEN** a filesystem target depends on variable or command substitution
- **THEN** policy SHALL emit an unresolved finding instead of guessing its path

### Requirement: Replaceable risk provider
Risk classification SHALL be accessed only through a Chimera-owned adapter and normalized to safe, caution, danger, or critical without exposing provider-specific types in public contracts.

#### Scenario: Provider replacement
- **WHEN** a different adapter returns equivalent normalized findings
- **THEN** downstream permission events, API schemas, and TUI behavior SHALL remain unchanged
