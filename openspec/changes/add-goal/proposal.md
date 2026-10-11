## Why

An agent stops when it thinks the work is done. For a long task that is often
too early: the tests still fail, or one of five steps is missing. The user
then reads the result and types "go on". Codex and Claude Code let the user
state the end condition once, and a second model checks it at each stop.

## What Changes

- `/goal <condition>` sets a completion condition for the session.
  `/goal clear` removes it. `/goal` shows it.
  `chimera run --goal "<condition>"` sets it for a headless run.
- After each clean stop of a run, when a goal is set, the `utilityModel` (the
  session model when none is set) reads the goal, the last assistant message,
  the task list and a short list of recent tool calls. It answers `met`,
  `not_met` with a reason, or `impossible` with a reason.
- `not_met`: Chimera gives the agent the reason in a message and the run
  goes on. This is the path a blocking Stop hook uses.
- User Stop hooks run first. When one blocks, the run goes on and the goal is
  checked at the next stop.
- `goal.maxContinuations` (default 20) limits the continuations of one run.
  At the limit the run ends with the reason `max_steps`, and the goal stays
  for the next run.
- `met` and `impossible` end the run and remove the goal.
- A new `goal_updated` event carries each change. The TUI shows the active
  goal and writes one line for each result.
- `chimera run --goal` exits with 0 when the goal is met, 2 at the limit, 3
  when the goal is not possible, and 1 when the check itself failed.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-core`: the session's goal, the check at a clean stop, the
  `goal_updated` event.
- `agent-server`: the route that sets and clears the goal.
- `cli`: `--goal`, `goal.maxContinuations`, the exit codes, the model call.
- `tui`: `/goal`, the goal in the panel and the footer, the result lines.

## Impact

- `packages/core`: `goal.ts`, the agent loop, the session type and its
  metadata, one event.
- `packages/server`, `packages/client`: one route and one method.
- `packages/cli`: config, `run`, the factory.
- `packages/tui`: slash command, scrollback, context panel, footer.
- Additive for SDK clients: one event, one optional session field. The
  finish reasons do not change.
