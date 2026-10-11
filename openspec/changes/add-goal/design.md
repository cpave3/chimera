## Context

At a clean stop the agent loop fires the Stop hook. A hook that blocks makes
the loop append its reason as a user message and start a new turn, up to
`MAX_STOP_RETRIES` times; past that the run ends with `max_steps`. Package 7
added `utilityModel`, and package 13 added `askModel` for a plain model call
and the pattern "rules in a library package, model call from the factory".

## Goals / Non-Goals

**Goals:**

- The user states the end condition once.
- The check needs evidence, not the agent's word.
- A wrong or weak checker cannot keep a run alive without end.

**Non-Goals:**

- A checker with tools. It reads what the session already holds.
- Goals for subagents. A child serves its parent's request.
- Several goals at once.

## Decisions

### D1. The goal is a field of the session

`session.goal = { condition }`, written to the session metadata, so a
resumed session still has it. `Agent.setGoal(condition | null)` sets or
clears it. Counters are not stored: they belong to one run.

### D2. The check is the last step of a clean stop

Order at a clean stop: the user's Stop hook; if it blocks, the loop goes on
as before and nothing else happens in that stop. Otherwise, with a goal set,
the check runs. So a user hook always sees the stop first, and the goal is
checked only when the hook lets the run end.

### D3. Three answers, and a fourth outcome

The checker replies with one JSON object, `{"result", "reason"}`, parsed as
the reviewer's answer is.

- `met`: the run ends with `stop`; the goal is removed.
- `not_met`: the reason goes to the agent and the run goes on.
- `impossible`: the run ends with `stop`; the goal is removed.
- The call fails, is late (60 seconds) or gives no readable answer: the run
  ends with `stop`, the goal stays, and the event says `unchecked`. A check
  that cannot be made must not keep the run alive, and must not claim
  success.

### D4. The message to the agent

The reason arrives in the user role, as a Stop hook's reason does. Its first
line has a fixed form, `[goal check] not met (2 of 20)`, and the second line
says that it is from Chimera and not from the user. A client reads the first
line back to show the message as one line, and the approval reviewer leaves
such a message out of "what the user asked".

### D5. The limit belongs to a run

`goal.maxContinuations` counts the `not_met` continuations of one run. At
the limit the run ends with `max_steps`, the reason the Stop hook limit
already gives, so no finish reason is added. The goal stays set: the user
can send a message and the next run counts from zero. Stop hook retries
keep their own counter.

### D6. What the checker reads

The goal; the last assistant message; the task list; the last 15 tool
calls, each as its name, a short form of its arguments and a short form of
its result or error. Each part has a size limit. The system text asks for
evidence: a claim with no tool result behind it is `not_met`, and the reason
must name the missing evidence.

### D7. One event

`goal_updated { condition, change, reason?, continuation?, maxContinuations? }`
where `condition` is the goal after the event (or null) and `change` is
`set`, `cleared`, `met`, `not_met`, `impossible`, `limit` or `unchecked`.
A client needs nothing else to show the goal and its history.

### D8. Exit codes of `chimera run --goal`

`met` → 0. Limit → 2, from `max_steps`. `impossible` → 3: a definite "no",
which a script must not confuse with "ran out of tries". `unchecked` → 1.
Without `--goal` nothing changes.

### D9. Where the code lives

`packages/core/goal.ts` holds the prompt, the parser and the message form;
the agent calls an `ask` function from its options. The factory supplies
`ask` with `askModel` and the `utilityModel`. A subagent session gets no
goal check.

## Risks / Trade-offs

- [The checker says `met` too early] → the system text asks for evidence
  from tool results; the user sees the reason in the transcript.
- [The checker never says `met`] → the limit ends the run; `/goal clear`
  ends the goal.
- [Each stop costs a model call] → only with a goal set; the input is
  bounded.
