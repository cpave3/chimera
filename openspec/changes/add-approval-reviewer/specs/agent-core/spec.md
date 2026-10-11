## ADDED Requirements

### Requirement: Approval review event
The agent SHALL emit `approval_reviewed` for each reviewer decision, with the request id, the decision and the reason, and with the `callId` of the tool call when the request came from one. When that decision made the reviewer stop for the session, the event SHALL say which limit was reached.

#### Scenario: Allowed command
- **WHEN** the reviewer allows the command of a `bash` tool call
- **THEN** an `approval_reviewed` event with the decision `allow` and that call's `callId` is emitted

### Requirement: Reviewer reason on a permission request
A `permission_request` event for a request the reviewer escalated SHALL carry the reviewer's reason.

#### Scenario: Escalated command
- **WHEN** the reviewer escalates a command with the reason "writes outside the task"
- **THEN** the `permission_request` event has that reason as `reviewerReason`
