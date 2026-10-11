## ADDED Requirements

### Requirement: Goal route
`PUT /v1/sessions/:id/goal` SHALL set the session's goal from `{ "condition": "<text>" }` and SHALL clear it for `{ "condition": null }`. It SHALL answer with the goal after the change. An empty condition SHALL be a 400. The change SHALL reach event subscribers as `goal_updated`, also while the session is idle. The session snapshot SHALL carry the goal.

#### Scenario: Set while idle
- **WHEN** a client sets a goal on an idle session
- **THEN** the response has the goal, and subscribers get `goal_updated` with the change `set`

#### Scenario: Clear
- **WHEN** a client sends `{ "condition": null }`
- **THEN** the session has no goal, and subscribers get `goal_updated` with the change `cleared`
