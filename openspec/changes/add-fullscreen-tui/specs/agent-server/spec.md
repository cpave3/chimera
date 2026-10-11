## ADDED Requirements

### Requirement: Session status endpoint
The server SHALL answer `GET /v1/sessions/:id/status` with the session's `status`, `mode`, `cwd`, and `name` when the session has one. The response SHALL NOT include messages. An unknown session id SHALL return 404.

#### Scenario: Idle session
- **WHEN** a client requests the status of an idle session in mode `plan`
- **THEN** the response is `{ "status": "idle", "mode": "plan", "cwd": "<cwd>" }`

#### Scenario: Unknown session
- **WHEN** a client requests the status of a session id that is not loaded
- **THEN** the response status is 404
