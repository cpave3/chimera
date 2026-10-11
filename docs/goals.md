# Goals

A goal is a completion condition that you state once. Chimera checks it each
time the agent stops, and the agent continues until the goal is met.

```
/goal pnpm test passes in packages/api and the changelog has an entry
/goal            # show the goal
/goal clear      # remove the goal
```

```
chimera run --goal "pnpm test passes in packages/api" "fix the failing tests"
```

The exit codes of `chimera run --goal` are in [Headless use](headless.md#exit-codes).

## How a goal works

- **The check.** When a run stops cleanly and the session has a goal, the
  `utilityModel` (the session model when none is set) reads the goal, the
  agent's last message, the task list and the last 15 tool calls with their
  results. It needs evidence from tool results. The agent's statement that
  the work is done is not evidence.
- **Three answers.** `met` ends the run and removes the goal. `not_met` gives
  the agent the reason, and the run continues. `impossible` ends the run and
  removes the goal.
- **Stop hooks first.** Your `Stop` hooks run before the check. When a hook
  blocks the stop, the run continues and the check waits for the next stop.
- **The limit.** One run continues at most `goal.maxContinuations` times
  (default 20). At the limit the run ends with the reason `max_steps`. The
  goal stays set, and your next message starts a new count.
- **A check that fails.** If the checker model fails, is late (60 seconds) or
  gives no readable answer, the run ends and the goal stays set.
- **On screen.** The context panel has a `GOAL` section (the footer in the
  inline layout). Each check adds one line to the transcript, for example
  `goal not met (1 of 20): the tests were not run`.
- **Subagents** have no goal check.

## Configuration

```json
{ "goal": { "maxContinuations": 20 } }
```

## For SDK clients

Clients get a `goal_updated` event for each change:
`{ condition, change, reason?, continuation?, maxContinuations? }`, where
`change` is `set`, `cleared`, `met`, `not_met`, `impossible`, `limit` or
`unchecked`. `PUT /v1/sessions/:id/goal` with `{ "condition": "<text>" }` or
`{ "condition": null }` sets or clears the goal.
