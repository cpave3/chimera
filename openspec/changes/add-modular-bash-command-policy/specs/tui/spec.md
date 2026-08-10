## MODIFIED Requirements

### Requirement: Permission modal
When permission events arrive, the TUI SHALL queue them FIFO by originating session and request ID and render one modal at a time. The modal SHALL show the target, full command, model reason, and any policy stage/risk/path/unresolved/error explanations without relying on color.

Ordinary requests SHALL retain allow/deny and remembered-command actions. Requests with mandatory findings SHALL hide remembered allow actions, offer allow once and deny once, offer deny with feedback, and offer allow plus session read/write directory only when the request contains one valid grant proposal. Main input SHALL remain inert while a modal is active.

#### Scenario: Concurrent parent and child requests
- **WHEN** permission requests from a parent and child session arrive before either is resolved
- **THEN** both SHALL remain queued and each resolution SHALL target its originating session/request

#### Scenario: Mandatory finding actions
- **WHEN** a policy request contains an unauthorized write and valid write-grant proposal
- **THEN** the modal SHALL explain the write and offer a session write-grant action but no remembered allow-pattern action

#### Scenario: Deny feedback editor
- **WHEN** the user selects deny with feedback and submits text
- **THEN** the TUI SHALL send one atomic action and retain the modal if the API reports failure
