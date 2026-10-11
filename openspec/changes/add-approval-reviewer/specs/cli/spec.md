## ADDED Requirements

### Requirement: Approval reviewer setting
The config SHALL accept `approvalReviewer.enabled` (default `false`). With it `true`, each session SHALL get an approval reviewer that calls the `utilityModel`, or the session's model when no `utilityModel` is set. A key the setting does not know SHALL be a config error.

#### Scenario: Off by default
- **WHEN** the config has no `approvalReviewer`
- **THEN** a request that needs approval goes to the user, and no reviewer model is called

#### Scenario: On
- **WHEN** `approvalReviewer.enabled` is `true` and a host command needs approval
- **THEN** the `utilityModel` is called with the command before the user is asked

### Requirement: Reviewer denial in a tool result
When the reviewer's escalation denies a call because nobody can be asked, the tool result SHALL say that the reviewer denied it and SHALL include the reviewer's reason.

#### Scenario: Headless run
- **WHEN** `chimera run` is headless and the reviewer escalates a command
- **THEN** the `bash` result contains `denied by reviewer` and the reason
