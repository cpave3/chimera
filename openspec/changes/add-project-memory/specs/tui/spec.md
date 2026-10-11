## ADDED Requirements

### Requirement: Memory command
`/memory` SHALL open the project's `MEMORY.md` in the user's editor, creating the file when it does not exist. When the editor exits, the TUI SHALL say that `/reload` brings the change into the running session. When memory is not available, `/memory` SHALL say so.

#### Scenario: Open
- **WHEN** the user runs `/memory`
- **THEN** the editor opens the project's `MEMORY.md`

#### Scenario: Memory off
- **WHEN** `memory.enabled` is `false` and the user runs `/memory`
- **THEN** the TUI says that project memory is turned off
