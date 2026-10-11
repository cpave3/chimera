## ADDED Requirements

### Requirement: Background child lines
For a child started with `background: true`, the transcript SHALL NOT nest the child's steps under the `spawn_agent` line. When the child ends, the transcript SHALL show one line with its purpose and end state.

#### Scenario: Child ends
- **WHEN** a background child with the purpose `map the auth flow` ends cleanly
- **THEN** the transcript shows one line that names `map the auth flow` and `done`
