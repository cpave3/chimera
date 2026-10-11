## ADDED Requirements

### Requirement: Session goal
A session SHALL hold at most one goal: a completion condition in the user's words. Setting a goal SHALL replace the one before. The goal SHALL be part of the persisted session, so that a resumed session has it.

#### Scenario: Resume
- **WHEN** a session with a goal is resumed
- **THEN** the session has the same goal

### Requirement: Goal check at a clean stop
When a run reaches a clean stop and the session has a goal, the agent SHALL ask the goal checker, which receives the goal, the last assistant message, the task list and a bounded list of recent tool calls. The user's Stop hook SHALL fire first; when it blocks, the goal SHALL NOT be checked at that stop.

- `met`: the run SHALL end with the reason `stop` and the goal SHALL be removed.
- `not_met`: the agent SHALL append a message with the checker's reason and SHALL start a new turn.
- `impossible`: the run SHALL end with the reason `stop` and the goal SHALL be removed.
- A check that fails, is late or gives no readable answer SHALL end the run with the reason `stop` and SHALL leave the goal set.

#### Scenario: Met
- **WHEN** the run stops and the checker answers `met`
- **THEN** the run ends with `stop` and the session has no goal

#### Scenario: Not met
- **WHEN** the run stops and the checker answers `not_met` with the reason "the tests were not run"
- **THEN** the agent gets a message that holds that reason and takes another turn

#### Scenario: Not possible
- **WHEN** the checker answers `impossible`
- **THEN** the run ends with `stop` and the session has no goal

#### Scenario: Stop hook first
- **WHEN** the user's Stop hook blocks the stop
- **THEN** the run goes on with the hook's reason and the checker is not called for that stop

#### Scenario: No goal
- **WHEN** the run stops and the session has no goal
- **THEN** the checker is not called

### Requirement: Goal continuation limit
The agent SHALL count the `not_met` continuations of a run. When the count reaches the configured limit, the run SHALL end with the reason `max_steps` and the goal SHALL stay set. The count SHALL start at zero in each run.

#### Scenario: Limit
- **WHEN** the limit is 2 and the checker answers `not_met` three times in one run
- **THEN** the run ends with `max_steps` after two continuations, and the session still has the goal

### Requirement: Goal event
The agent SHALL emit `goal_updated` when the goal is set or cleared and after each check, with the goal after the change, what changed (`set`, `cleared`, `met`, `not_met`, `impossible`, `limit` or `unchecked`) and the checker's reason when there is one.

#### Scenario: Not met
- **WHEN** the checker answers `not_met` for the first time in a run with the limit 20
- **THEN** a `goal_updated` event with the change `not_met`, the reason, continuation 1 and limit 20 is emitted
