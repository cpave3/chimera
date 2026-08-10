## ADDED Requirements

### Requirement: Structured permission policy events
Core permission requests and events SHALL carry optional provider-neutral policy analysis while preserving ordinary non-policy permission requests.

#### Scenario: Enriched request event
- **WHEN** host bash policy requires approval
- **THEN** the emitted permission request SHALL contain ordered stage summaries and every normalized finding

### Requirement: Ordered denial feedback
Core SHALL atomically bind non-empty user feedback to a pending denied permission so the denied tool result is recorded before feedback is injected at the next clean run boundary. Accepted feedback SHALL not be silently dropped if the run terminates before that boundary.

#### Scenario: Continuing run observes feedback
- **WHEN** a pending command is denied with feedback
- **THEN** the next model step SHALL observe the denied tool result followed by the user feedback

#### Scenario: Stale request
- **WHEN** feedback targets a resolved or unknown permission request
- **THEN** core SHALL reject it without injecting the message
