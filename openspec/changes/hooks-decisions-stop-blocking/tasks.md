## 1. Extend hook types and runner with JSON decision parsing

- [x] 1.1 Expand `HookFireResult` with optional `decision` JSON field in `packages/hooks/src/types.ts`
- [x] 1.2 Capture `stdout` in `DefaultHookRunner.runOne` and parse JSON on exit 0 in `packages/hooks/src/runner.ts`
- [x] 1.3 Support `hookSpecificOutput` wrapper for Claude compat in the JSON parser
- [x] 1.4 Cap parsed string values at 10,000 chars; write overflow to temp file
- [x] 1.5 Handle corrupted stdout (EPIPE during write) gracefully without losing decision

## 2. Make Stop hooks blockable from within Agent.run

- [x] 2.1 Add `stopHook?: StopHook` to `AgentOptions` in `packages/core/src/agent.ts`
- [x] 2.2 Introduce `MAX_STOP_RETRIES` constant (5) inside `Agent` class
- [x] 2.3 Refactor `runInternal` to wrap the outer loop in a retry loop, firing `Stop` hook before `run_finished` for `terminalReason === "stop"`
- [x] 2.4 When `Stop` hook blocks, emit `user_message` event on queue and append message to `session.messages`
- [x] 2.5 When retry count reaches cap, emit `run_finished` with `reason: "max_steps"`
- [x] 2.6 Ensure Interrupted or Error terminal reasons bypass the Stop hook entirely

## 3. Wire stopHook into Agent through factory

- [x] 3.1 Create `stopHook` adapter in `packages/cli/src/factory.ts` delegating to `DefaultHookRunner`
- [x] 3.2 Pass `stopHook` into `AgentOptions` in `packages/cli/src/factory.ts`

## 4. Remove double Stop firing from event-bus bridge

- [x] 4.1 Remove `case 'run_finished'` from `packages/server/src/hook-bridge.ts`
- [x] 4.2 Update `bridgeHooksToBus` JSDoc to reflect that `Stop` is now handled inside the agent
- [x] 4.3 Verify `SessionEnd` hook is still fired from `agent-registry.ts` on session cleanup (unchanged)

## 5. Update tests

- [x] 5.1 Add runner tests for JSON decision parsing (valid JSON block, empty stdout, non-JSON stdout, `hookSpecificOutput`, large output)
- [x] 5.2 Add runner test: exit 0 + JSON decision sets `blocked` and fills `HookFireResult.decision`
- [x] 5.3 Add core agent test: `Stop` hook blocks → no `run_finished`, `user_message` emitted, run continues
- [x] 5.4 Add core agent test: `Stop` hook allows → `run_finished` emitted normally
- [x] 5.5 Add core agent test: error/interrupted terminal reasons skip Stop hook entirely
- [x] 5.6 Add core agent test: 5 block cap → `run_finished` with `max_steps`
- [x] 5.7 Update server hook-bridge test to remove `run_finished → Stop` mapping assertions
- [x] 5.8 Verify permissions gate tests still pass (no breaking change to `PermissionRequest` hook behavior)

## 6. Build and verify

- [x] 6.1 `pnpm -r build` — no type errors across packages
- [x] 6.2 `pnpm -r test` — all test suites pass
- [ ] 6.3 Manual check: create a test hook script that writes `{ "decision": "block", "reason": "stop blocked" }` and verify the agent loops back
