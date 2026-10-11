## ADDED Requirements

### Requirement: Reviewer marks
The TUI SHALL mark a tool line whose call the approval reviewer allowed. The permission prompt of a request the reviewer escalated SHALL show the reviewer's reason. When the reviewer stops for the session, the TUI SHALL show one notice that says so.

#### Scenario: Allowed call
- **WHEN** an `approval_reviewed` event with the decision `allow` names a tool call
- **THEN** that tool line shows that the reviewer approved it

#### Scenario: Escalated call
- **WHEN** a `permission_request` carries a reviewer reason
- **THEN** the prompt shows the reason

#### Scenario: Reviewer stops
- **WHEN** an `approval_reviewed` event says the reviewer stopped
- **THEN** the transcript gains one line that says the reviewer stopped for this session
