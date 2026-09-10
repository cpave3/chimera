# `o7oe8cyh` — spawn_agent timeout

| | |
| --- | --- |
| **Type** | Change request (filed as a bug, but current behavior matches the accepted specification) |
| **Verdict** | Confirmed: `spawn_agent` deliberately stops a still-running child after 10 minutes by default. A separate, general 120-second stalled-model-response timeout can produce the same terminal reason. |
| **Cause / Gap** | The tool always resolves an omitted `timeout_ms` to `600_000` and the shared subagent driver converts that wall-clock deadline into an interrupt and `reason: "timeout"`. |
| **Recommendation** | Remove the default total-run deadline while retaining `timeout_ms` as an explicit opt-in cap; do not remove the separate stalled-provider safeguard without evidence that it caused the report. |
| **Severity / Value** | Medium — long but healthy delegated work is terminated and its final result is unavailable to the parent, but no persisted user data is corrupted. |
| **Confidence** | Confirmed for the 10-minute mechanism by source trace and automated test; unknown which of the two clocks the reporter observed because elapsed time and error text were not supplied. |
| **Effort** | Small (approximately half a day including specification, tests, and documentation) |
| **Source** | Task `o7oe8cyh`; reporter/date/version/environment not provided |

## What was reported

The reporter observed that the `spawn_agent` tool times out “after a while” and wants subagents not to time out. No exact elapsed time, terminal result, logs, Chimera version, provider, execution mode, or reproduction steps were supplied. The requested behavior is clear, but the missing duration matters because Chimera has two independent timeout mechanisms that can terminate a subagent with the same `timeout` reason.

This is classified as a **change request**, not an implementation defect: the current 10-minute total-run cap is explicitly specified in `openspec/specs/subagents/spec.md:16-30` and described by the tool schema in `packages/subagents/src/spawn-tool.ts:42-47`. The original design recorded it as a provisional choice to revisit after observing real use (commit `488b632`, `openspec/changes/archive/2026-04-27-add-subagents/design.md`, “Open Questions”). This ticket supplies that usage signal.

## Current behaviour

There are two relevant clocks:

1. **Subagent total-run clock (10 minutes by default).** `spawn_agent` accepts an optional positive `timeout_ms`, advertised as a per-call wall-clock cap with a 600,000 ms default (`packages/subagents/src/spawn-tool.ts:42-47`). During every invocation, an omitted argument falls back first to the embedding context’s `defaultTimeoutMs`, then unconditionally to `DEFAULT_TIMEOUT_MS = 600_000` (`packages/subagents/src/spawn-tool.ts:10-11`, `packages/subagents/src/spawn-tool.ts:139-146`). The standard CLI factory does not set `defaultTimeoutMs` when it constructs the tool (`packages/cli/src/factory.ts:624-659`), so normal CLI/TUI/server use gets the hard-coded 10-minute fallback.

2. **Agent model-response clock (120 seconds per LLM step by default).** Every `Agent`, not only subagents, starts a timer around each `streamText` step; `responseTimeoutMs` defaults to 120,000 ms and `0` disables it (`packages/core/src/agent.ts:1463-1469`, `packages/core/src/agent.ts:2097-2105`). The setting is available in Chimera config (`packages/cli/src/config.ts:103-107`) and is passed into interactive, one-shot, and server factories (`packages/cli/src/commands/interactive.ts:153-162`, `packages/cli/src/commands/run.ts:164-173`, `packages/cli/src/commands/serve.ts:166-179`). This timer detects a stalled provider response, not a long multi-step task.

Both child-process and in-process `spawn_agent` paths pass the resolved total-run timeout to the same driver (`packages/subagents/src/spawn-tool.ts:193-198`, `packages/subagents/src/spawn-tool.ts:265-270`). The driver starts one timer for the entire delegated run. When it fires, it marks the run timed out, aborts the child send stream, calls the child interrupt path, and ultimately returns `reason: "timeout"` (`packages/subagents/src/subagent-driver.ts:31-49`, `packages/subagents/src/subagent-driver.ts:72-88`). For child-process agents, normal post-drive cleanup then deletes the child session and terminates the process (`packages/subagents/src/spawn-tool.ts:265-285`, `packages/subagents/src/spawn-child.ts:240-255`).

The parent blocks until `spawn_agent` returns the child’s final answer (`packages/subagents/src/spawn-tool.ts:59-70` and `SUBAGENTS.md:18-22`). Therefore a total-run timeout can return only the last completed assistant text, or an empty string if none completed, rather than the intended final synthesis (`packages/subagents/src/spawn-tool.ts:210-217`, `packages/subagents/src/spawn-tool.ts:282-289`).

## Reproduction

The repository already has an executable reproduction of the timeout mechanism. `packages/subagents/test/spawn-tool.test.ts:289-323` creates a child that remains active until aborted, invokes `spawn_agent` with `timeout_ms: 50`, and asserts `reason === "timeout"`. Running the `@chimera/subagents` Vitest suite on 2026-09-10 passed this case (55 passed, 2 skipped), confirming the timer-to-interrupt behavior.

The hard-coded default itself was not exercised for ten real minutes. It is nevertheless **confirmed by source trace**: the fallback at `packages/subagents/src/spawn-tool.ts:146` always supplies 600,000 ms in the standard factory, and the driver starts a timer for every positive supplied value at `packages/subagents/src/subagent-driver.ts:43-49`.

Trigger conditions:

- A healthy subagent whose complete delegated run lasts longer than 600,000 ms triggers the subagent-specific cap when `timeout_ms` is omitted.
- Any explicit positive `timeout_ms` replaces the 10-minute cap.
- A single child LLM step that stalls longer than `responseTimeoutMs` can terminate earlier (120 seconds by default), regardless of total task age.
- Parent cancellation is a different path and normally reports `interrupted`, not `timeout` (`packages/subagents/src/subagent-driver.ts:72-86`).

## Root cause

The 10-minute behavior is **confirmed** end to end:

1. `packages/subagents/src/spawn-tool.ts:10-11` defines the total-run default:

   ```ts
   const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes per spec.
   ```

2. `packages/subagents/src/spawn-tool.ts:139-150` converts every omitted per-call value into that positive default:

   ```ts
   const timeoutMs = validated.timeout_ms ?? ctx.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
   const effectiveSignal = combineSignals(abortSignal, ctx.parentAbortSignal);
   ```

3. `packages/subagents/src/spawn-tool.ts:193-198` and `packages/subagents/src/spawn-tool.ts:265-270` pass the same timeout to both execution modes.

4. `packages/subagents/src/subagent-driver.ts:43-49` schedules an interrupt for that deadline:

   ```ts
   if (opts.timeoutMs && opts.timeoutMs > 0) {
     timeoutHandle = setTimeout(() => {
       timedOut = true;
       onParentAbort();
     }, opts.timeoutMs);
   }
   ```

5. `packages/subagents/src/subagent-driver.ts:72-88` ensures the externally visible terminal reason is `timeout`, even if the interrupt makes the child stream finish cleanly.

The code is behaving as designed. The defect is now in the intended default: a fixed total wall-clock cap treats active, progressing work like a hung process. Existing parent cancellation and per-step provider timeout mechanisms already cover user cancellation and stalled model calls.

**First introduced in:** commit `488b632` (`feat(subagents): spawn_agent tool with end-to-end TUI and observability`, 2026-04-25). The constant and fallback were present in the initial implementation. Commit `1404b19` later extracted the same behavior into `driveSubagent`; it did not introduce the policy.

## Impact

- **Who is affected:** All standard CLI, TUI, and server users whose delegated run exceeds ten minutes without an explicit larger `timeout_ms`; both child-process and in-process modes are affected.
- **Blast radius:** The total-run cap is isolated to `spawn_agent`. The separate 120-second response clock applies to parent agents and subagents alike.
- **Data integrity:** No evidence of persisted data corruption. Tool/file side effects completed before interruption remain in the workspace, but the parent may not receive a final summary of them.
- **Workaround:** Ask the parent model to pass a much larger `timeout_ms` for expected long tasks. There is no documented CLI/config setting for the total-run default because the standard factory does not expose `SpawnAgentToolContext.defaultTimeoutMs`. If the observed timeout is exactly 120 seconds during a silent provider response, set `responseTimeoutMs: 0` (or a larger value) in `~/.chimera/config.json`; that changes the general per-step safeguard for all agents.

## Ruled out

- ~~Child startup/handshake timeout~~ — the startup timers are 10 seconds for the handshake and 3 seconds for health (`packages/subagents/src/spawn-child.ts:10-13`), and handshake failure returns `reason: "error"` before `subagent_spawned`, not a later `timeout` result (`packages/subagents/src/spawn-tool.ts:231-254`).
- ~~Maximum nesting depth~~ — depth enforcement returns a named `error` before spawning (`packages/subagents/src/spawn-tool.ts:152-158`), not `timeout` after work has run.
- ~~Maximum model steps~~ — this returns `max_steps`, a distinct result represented separately in `SubagentReason` (`packages/subagents/src/types.ts:5-11`).
- ~~SSE permission timeout~~ — the client’s timer is attached to unresolved permission requests and emits `permission_timeout`; it is not a total run deadline (`packages/client/src/client.ts:405-420`, `packages/client/src/client.ts:447-463`).
- ~~Unexpected regression~~ — specification and history show the 10-minute default was intentional from the first subagent implementation (`openspec/specs/subagents/spec.md:16-30`; commit `488b632`).

## Options

### Option 1 — No default total-run deadline; retain explicit opt-in timeout (recommended)

Change `spawn_agent` so omitted `timeout_ms` passes no timeout to `driveSubagent`. Preserve explicit positive `timeout_ms` for callers that need bounded orchestration, and preserve an explicitly configured `SpawnAgentToolContext.defaultTimeoutMs` for non-CLI embedders if that extension point is still wanted. Update the tool description and OpenSpec default from `600000` to no default deadline.

- **Effort:** Small.
- **Risk:** Low. The driver already treats `undefined` as no timer (`packages/subagents/src/subagent-driver.ts:43-49`). Parent interrupt remains available, and stalled LLM steps retain their separate timeout.
- **Does not address:** A provider step that stalls for the configured `responseTimeoutMs`; that is a separate safeguard.

### Option 2 — Add a user-configurable total-run default

Add a `subagents.timeoutMs` configuration value, thread it through each CLI command into `CliAgentFactory`, and then into `SpawnAgentToolContext.defaultTimeoutMs`. Define `0` as disabled and make it the default to meet the ticket.

- **Effort:** Medium because it changes config types, all construction paths, examples/docs, and tests.
- **Risk:** Medium. It introduces two similarly named timeout settings (`responseTimeoutMs` and subagent total runtime) that users can easily confuse.
- **Does not improve:** Per-call behavior beyond what `timeout_ms` already provides. This is only justified if operators need a centrally enforced total-run policy.

### Option 3 — Remove total-run timeout support entirely

Delete `timeout_ms`, `defaultTimeoutMs`, and total-run timer handling. Rely on parent interruption and the general per-step response timeout.

- **Effort:** Small to medium because it is a public tool-contract removal.
- **Risk:** Medium. API/SDK consumers lose the useful ability to bound selected delegated calls, and existing prompts that supply `timeout_ms` become invalid.
- **Does not improve:** Stalled-provider diagnosis or timeout messaging.

### Option 4 — Keep current behavior and document a larger timeout

Document that callers should request a larger `timeout_ms` for long work.

- **Effort:** Very small.
- **Risk:** High for reliability because the model, rather than the user or runtime policy, must remember to override a hidden default.
- **Does not satisfy:** The stated requirement that subagents should not time out by default.

## Recommendation

Implement **Option 1**. It directly satisfies the underlying need—healthy delegated work can run until completion—without removing cancellation or hung-provider protection. It also uses behavior the driver already supports instead of adding configuration plumbing. Option 2 adds configuration complexity without a demonstrated operator need; Option 3 unnecessarily removes an explicit per-call safety control; Option 4 leaves the reported failure mode intact.

### Files to touch

- `packages/subagents/src/spawn-tool.ts` — remove the hard-coded 600,000 ms fallback; describe omitted `timeout_ms` as unlimited; pass `undefined` unless the call or embedding context explicitly supplies a timeout.
- `packages/subagents/test/spawn-tool.test.ts` — retain the explicit timeout test and add a default-no-timeout regression test through the public `buildSpawnAgentTool(...).tool.execute` entry point. Use fake timers or a short pending child, advance beyond the former default, assert the call is still pending, then abort the parent and assert clean `interrupted` completion.
- `openspec/specs/subagents/spec.md` — change the `timeout_ms` contract from default 600,000 to opt-in/no default, and add scenarios for omitted and explicit deadlines.
- `SUBAGENTS.md` — document that subagents have no total-run deadline by default, that `timeout_ms` is available for explicitly bounded work, and distinguish it from `responseTimeoutMs`.
- `packages/subagents/src/types.ts` — update the `defaultTimeoutMs` comment if the embedding override remains; remove the field only if maintainers choose not to preserve the extension point.

No CLI, persistence, database, migration, permission, UI-state, localization, or sandbox changes are required for Option 1. The existing `timeout` result remains necessary because explicit call deadlines and child `responseTimeoutMs` can still produce it.

### Acceptance criteria

1. Calling `spawn_agent` without `timeout_ms` does not create a total wall-clock deadline and can continue beyond ten minutes while making progress.
2. Calling `spawn_agent` with a positive `timeout_ms` still interrupts the child at approximately that deadline and returns `reason: "timeout"`.
3. Parent `Ctrl+C`/interrupt still cascades and returns `reason: "interrupted"`.
4. Both child-process and in-process modes have the same omitted/explicit deadline semantics.
5. The general `responseTimeoutMs` safeguard remains unchanged and can still be disabled with `0` when desired.
6. Timeout cleanup still disposes an in-process child or deletes and terminates a child-process agent.
7. Tool schema text, user documentation, and OpenSpec agree on the new default.

### Verification

- Run `pnpm --filter @chimera/subagents test` after adding the omitted-timeout regression and retaining the explicit-timeout and interrupt tests.
- Run `pnpm --filter @chimera/subagents build`, then test downstream CLI consumption because workspace packages consume built `dist/`.
- Run the relevant CLI factory tests to confirm the generated `spawn_agent` schema advertises no default total cap.
- Manual end-to-end check: start a delegated task without `timeout_ms`, observe it remain active beyond the former cap, then interrupt it and confirm the child process/session is cleaned up. A shortened injected/default clock in a test harness is preferable to a ten-minute CI test.

### Rollout concerns

No migration, feature flag, or backfill is needed. This is a default-behavior change: unattended subagents can now run indefinitely if they continue producing non-stalled steps. Parent cancellation, process supervision, the per-step response timeout, and optional explicit `timeout_ms` limit that risk. Release notes should call out the default change for operators who relied on the implicit ten-minute budget; those callers should begin passing an explicit timeout.

### Related decisions

The recommendation intentionally revises the baseline requirement at `openspec/specs/subagents/spec.md:16-30`. The original archived design explicitly marked the ten-minute value as provisional and said to revisit it after observing real use (`openspec/changes/archive/2026-04-27-add-subagents/design.md`, commit `488b632`, “Open Questions”), so no enduring architectural decision blocks this change.

## Risks and unknowns

- The reporter’s elapsed time and result payload are unknown. If the observed failure occurred at approximately 120 seconds rather than 10 minutes, changing the subagent total-run default will not fix that occurrence; the relevant mechanism is `responseTimeoutMs`.
- The report did not run a real provider-backed subagent for ten minutes. The total-run mechanism is confirmed from the complete code path and its short-duration automated test.
- Removing the default allows an agent that repeatedly completes LLM steps but never finishes its task to run until user/process cancellation. The existing max-step limit and per-step timeout still bound common runaway/stall cases, but they do not guarantee a total wall-clock ceiling.
- The exported `SubagentSpawnOptions` type is not used internally outside its barrel export (`packages/subagents/src/types.ts:13-24`, `packages/subagents/src/index.ts:3-10`). Its camelCase `timeoutMs` does not currently provide a separate public execution path.

## Open questions for the reporter

1. Did the timeout occur at approximately 120 seconds, 10 minutes, or another duration?
2. What exact tool result or TUI label was shown (`timeout`, `interrupted`, `error`, or text such as `step timed out after ...ms`)?
3. Was the child still making progress (tool calls/assistant output), or was it silent while waiting for a provider response?
