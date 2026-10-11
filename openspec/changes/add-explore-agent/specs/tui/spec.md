## ADDED Requirements

### Requirement: Background child lines
For a child started with `background: true`, the transcript SHALL NOT nest the child's steps under the `spawn_agent` line. When the child's answer is delivered, the transcript SHALL show one line with its purpose and end state, and SHALL NOT show the delivered message as a user message. The working tree section of the context panel SHALL name an untracked directory.

#### Scenario: Child ends
- **WHEN** a background child with the purpose `map the auth flow` ends cleanly
- **THEN** the transcript shows one line that names `map the auth flow` and `done`
