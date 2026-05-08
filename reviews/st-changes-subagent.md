# Subagent system refactoring — changelog

## Files modified

- `packages/subagents/src/subagent-driver.ts` **(new)**
  - Extracted shared `driveSubagent` loop from `driveChild` and `driveInProcess`.
  - Contains `SubagentTransport` interface (send + interrupt) used by both child-process and in-process paths.
  - Handles parent-signal propagation, timeout, interrupt cascade, event accumulation, and reason classification in one place.

- `packages/subagents/src/spawn-child.ts`
  - Replaced verbatim ~70-line `driveChild` with a thin `ChildTransport` adapter that delegates to `driveSubagent`.
  - Fixed **O(n²) stderr string concatenation** (spawn-child.ts:116-122). Accumulates chunks in a bounded `string[]`, joining once on handshake failure.
  - Added `STDERR_BUF_MAX` constant for clarity.

- `packages/subagents/src/spawn-in-process.ts`
  - Replaced verbatim ~70-line `driveInProcess` with a thin `InProcessTransport` adapter that delegates to `driveSubagent`.

- `packages/subagents/src/spawn-tool.ts`
  - Added `ARGS_SCHEMA.parse(args)` at the top of `execute` so direct callers (including unit tests) get validated args instead of deep failures.
  - Replaced all raw `args.*` reads with `validated.*`.
  - **Removed caller-side `interruptChild` listener** (spawn-tool.ts:257-260). Interrupt is now handled uniformly inside `driveSubagent` by the transport adapter.
  - Removed unused `interruptChild` import.

- `packages/subagents/test/e2e-spawn.test.ts`
  - Switched stderr buffering from `stderrBuf +=` to a `string[]` chunk accumulator, matching the main source fix.

- `packages/subagents/test/spawn-tool.test.ts`
  - Added `vi.mock` for `spawn-child` to inject mocked `ChildHandle`s.
  - Added `makeMockChildHandle` helper.
  - **New test suite:** "child-process happy path (mocked)" with 3 tests:
    1. Happy path: spawn → drive → teardown, verifies events and result.
    2. Handshake failure: `spawnChimeraChild` rejection surfaces as error result.
    3. Parent-abort cascade: confirms `interrupt()` is called on the mocked child handle.

- `packages/subagents/test/parallel-interrupt.test.ts`
  - Added `vi.mock` for `spawn-child` to enable child-process mocking in this file.
  - **New test:** "aborts both in-flight child-process children when the parent signal fires" — parallel interrupt for mocked child handles, asserting both get interrupted.

## Summary of behavioral changes

1. **Unified interrupt handling.** Previously the in-process path interrupted inside the drive loop while the child-process path required the caller (`spawn-tool.ts`) to attach a separate `effectiveSignal` listener. Now both paths interrupt via the same `SubagentTransport.interrupt()` callback inside `driveSubagent`. This removes the fragile split and means removing the listener in `spawn-tool.ts` no longer risks silently breaking interrupt cascade.

2. **Bounded stderr buffer.** On a chatty child (crashing server, verbose debug build) the old string-concat pattern was O(n²) in total bytes emitted. The new array-based buffer caps total bytes and only joins once on handshake failure.

3. **Schema validation at entry point.** `ARGS_SCHEMA.parse(args)` now runs inside `execute` regardless of whether the AI SDK or a direct test caller invokes it. Tests already pass valid args, so this is zero-impact for existing callers but closes the validation gap for ad-hoc direct invocations.

4. **Drive-loop deduplication.** The shared `driveSubagent` eliminates ~140 lines of near-identical logic across the two transport files. Transport-specific differences (child handle shape, how to interrupt) are isolated in thin adapter classes (`ChildTransport`, `InProcessTransport`).

## Caveats / follow-ups

- The `ChildTransport.send` method casts events from `ChimeraClient.send` because `ChimeraClient` is loosely typed. If `ChimeraClient` gains stricter typing, the cast can be removed.
- `spawn-tool.ts` still casts `opts.toolCallId` (`(opts as { toolCallId?: string }).toolCallId`) because `defineTool` options type does not include it. A follow-up could extend the options type upstream in `@chimera/tools`.
- E2E tests for child-process spawning remain gated on `CHIMERA_TEST_E2E=1` and were not modified beyond the stderr fix; no new E2E tests were added.
