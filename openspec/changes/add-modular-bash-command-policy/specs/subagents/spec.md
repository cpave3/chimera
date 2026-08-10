## ADDED Requirements

### Requirement: Subagent host bash policy
Subagents SHALL inherit the effective host bash policy. TTY-routed child requests SHALL preserve policy findings and resolve against the child session; headless child escalations SHALL deny without hanging.

#### Scenario: TTY-routed child request
- **WHEN** a child host command requires approval and the parent has a TTY
- **THEN** the parent TUI SHALL display the child request and route the selected action to the child session

#### Scenario: Headless child escalation
- **WHEN** a child without an interactive route receives a mandatory finding
- **THEN** the command SHALL be denied without execution or indefinite waiting
