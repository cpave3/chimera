## ADDED Requirements

### Requirement: Skill index size limit
The skill index in the system prompt SHALL take at most 2% of the model's context window, estimated at four characters a token. When the full index is larger, the index SHALL list skill names grouped by skills directory, without descriptions, and SHALL say where a skill's file is.

#### Scenario: Small library
- **WHEN** the full index is within the limit
- **THEN** each skill has its name, description and path

#### Scenario: Large library
- **WHEN** the full index is larger than 2% of the context window
- **THEN** the index has one line per skills directory with the names of its skills, and no descriptions
