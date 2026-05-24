## ADDED Requirements

### Requirement: Stop hook blocking

When an agent run reaches a terminal step with `reason: "stop"`, the agent SHALL fire the `Stop` hook synchronously before emitting `run_finished`. If the hook returns `blocked: true` (via exit 2 or JSON `decision: "block"`), the agent SHALL not emit `run_finished`; instead, it SHALL append a system/user message to the session containing the block reason and loop back into a fresh LLM turn.

The `Stop` hook SHALL only fire for terminal reason `"stop"`. For `"error"`, `"interrupted"`, or `"max_steps"`, the hook SHALL NOT fire and the session SHALL terminate normally.

The retry loop SHALL run a maximum of 5 times. On the 5th block, the agent SHALL emit `run_finished` with `reason: "max_steps"`.

Each retry turn SHALL include the block reason in the conversation so the model knows why it was not allowed to stop. This message SHALL be emitted as a `user_message` event on the queue for TUI display and appended to `session.messages` as a user message.

#### Scenario: Stop hook blocks and agent retries
- **WHEN** an agent run completes with reason `"stop"` and a `Stop` hook returns `{ "decision": "block", "reason": "lint errors found" }`
- **THEN** the agent SHALL NOT emit `run_finished`; it SHALL append a user message `"lint errors found"` to the session, emit a `user_message` event, and begin a new LLM turn

#### Scenario: Stop hook allows, agent finishes
- **WHEN** an agent run completes with reason `"stop"` and a `Stop` hook exits 0 with no JSON decision
- **THEN** the agent SHALL emit `run_finished` with `reason: "stop"` normally

#### Scenario: Stop hook is not called for errors
- **WHEN** an agent run completes with reason `"error"` and a `Stop` hook is installed
- **THEN** the hook SHALL NOT fire and `run_finished` with `reason: "error"` SHALL be emitted immediately

#### Scenario: Safety cap prevents infinite stop blocks
- **WHEN** a `Stop` hook blocks 5 consecutive times on the same run
- **THEN** on the 5th block the agent SHALL emit `run_finished` with `reason: "max_steps"`
