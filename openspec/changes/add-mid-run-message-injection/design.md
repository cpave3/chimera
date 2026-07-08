## Context

The agent run loop (`Agent.runInternal`) is an outer `while (true)` over an
inner `for` loop of `streamText` steps. Each step either emits tool calls
(intermediate — the loop continues to consume results) or stops (terminal —
the loop breaks). The loop already has two precedents for mid-run user-message
injection:

1. `pendingImageMessages` — tool-produced images drained as a user message at
   the step boundary (`agent.ts:1619`).
2. The stop-hook retry — pushes a user message and `continue`s the outer loop
   (`agent.ts:1745`).

This change adds a third, `pendingInjectMessages`, drained at the same step
boundary, and reuses the stop-hook's `continue` pattern to loop back on a
terminal step so the model responds.

## Drain placement

The drain runs **after** the `terminalReason !== 'stop'` break
(`agent.ts:1656`). Rationale: an interrupted or errored step should drop pending
injects — "interrupt means stop." If the user interrupted, they do not want the
run to continue into the injected content. The buffer is also cleared at the
top of every fresh `run()` (`agent.ts:1019`), so a crashed run cannot leak
injects into the next one.

On an intermediate step (tool calls emitted), the drain happens, then the
existing `continue` picks up the injected messages on the next `streamText` —
no new control flow needed.

On a terminal step (stop), the drain happens, then a new `continue` loops the
outer `while` so the model responds to the injected content. A fresh
`AbortController` is installed (matching the stop-hook retry) so the new turn is
independently interruptible. `terminalStepCount` is incremented before the
`continue`, so the `maxTerminalSteps` cap still bounds runaway inject loops.

## Registry routing

`AgentRegistry.injectMessage` gains a mid-run branch: when `entry.runActive` is
true (and no compaction/inject/rewind is active), it calls
`entry.agent.injectRunMessage(content, images)` synchronously and returns
`'injected'`. It does **not** call `snapshotWorkspace` — mid-run tree state is
half-modified, so the pre-run checkpoint is the correct restore target for
`/rewind`. It does **not** publish `user_message` on the bus — the run loop
emits it at drain time, so the TUI's scrollback sees exactly one `user_message`
per inject.

## TUI behavior

`handleSubmit` now distinguishes `running` from the broader `busy`:

- `running` → `injectMidRun(text)` (calls `client.appendMessage`, shows
  "injected: ..."). The run loop's `user_message` event renders the "you: ..."
  row at drain time.
- `busy && !running` (compacting or `!` in flight) → queue (the original
  behavior). There is no active run to inject into.
- `!` commands and `/rewind` / `/compact` slash actions still queue — they are
  post-run side effects, not model-facing directives.

Expanded user-command and skill bodies (the `default:` branch of `handleSlash`)
use `if (running) injectMidRun(...)` — same rule.

Attach-token (`@`/`#`) and image processing is skipped for mid-run injects in
v1: `injectMidRun` sends plain text only. This keeps the injection fast and
predictable; the idle `sendUserMessage` path retains full attach/image
handling.

## Edge cases

- **Run about to end (terminal step, no tool calls):** injected message drains,
  loop continues, model responds.
- **Interrupted/errored step:** drain is skipped (break fires first); buffer
  cleared at next run start.
- **Compaction active:** registry returns `already-running` (409); TUI queues.
- **Multiple injects:** all drain in FIFO order at the next boundary.
- **Idle inject:** existing `appendMessage` path, unchanged.
