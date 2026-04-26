## 1. New `@chimera/hooks` package

- [x] 1.1 Create `packages/hooks/` with `package.json`, `tsconfig.json`, and the standard build/test scripts mirroring `packages/permissions/`
- [x] 1.2 Add the `Event` union type covering `UserPromptSubmit`, `PostToolUse`, `PermissionRequest`, `Stop`, `SessionEnd`
- [x] 1.3 Add the per-event payload TypeScript types and a single discriminated `HookPayload` union keyed on `event`
- [x] 1.4 Add a `HookRunner` interface with one method: `fire(payload: HookPayload, opts: { cwd: string }): Promise<HookFireResult>` where `HookFireResult` reports whether any pre-event hook blocked
- [x] 1.5 Implement directory discovery: list `~/.chimera/hooks/<event>/` then `<cwd>/.chimera/hooks/<event>/`, return executable regular files (or symlinks to regular files) sorted lexicographically per directory, globals first
- [x] 1.6 Implement script execution: spawn with stdin = JSON payload, env = parent env + `CHIMERA_EVENT` / `CHIMERA_SESSION_ID` / `CHIMERA_CWD`, `cwd` = session cwd, 30s timeout, capture stderr for warnings
- [x] 1.7 Implement exit-code classification: pre-events block on exit 2 (and on no other code or signal); post-events log warnings on any non-zero exit; timeouts and exec failures fail-open for pre, fail-soft for post
- [x] 1.8 Add a `NoopHookRunner` export for tests/embedders that don't want hook side effects

## 2. `@chimera/permissions` integration

- [x] 2.1 Add an optional `hookRunner: HookRunner` parameter to `GatedExecutor`'s constructor
- [x] 2.2 In `GatedExecutor.exec()`, between the rule-store check and the user prompt, call `hookRunner.fire({ event: "PermissionRequest", ... })` if a runner is configured
- [x] 2.3 If the fire result reports a block, return `{ error: "denied by hook" }` to the model and emit `permission_resolved` with `decision: "deny"`, `remembered: false`
- [x] 2.4 Confirm existing tests still pass without supplying `hookRunner` (no behavior change when omitted)

## 3. `@chimera/server` wiring

- [x] 3.1 Construct one `HookRunner` instance per session at session creation, parameterized with the session's `cwd`
- [x] 3.2 Pass that runner into the `GatedExecutor` for the session
- [x] 3.3 Subscribe to the session's `AgentEvent` stream and translate events into hook firings:
  - `user_message` → `UserPromptSubmit` (carry `user_message` text)
  - `tool_call_result` → `PostToolUse` (success path; carry `tool_name`, `tool_input`, `tool_result`)
  - `tool_call_error` → `PostToolUse` (error path; carry `tool_name`, `tool_input`, `tool_error`)
  - `run_finished` → `Stop` (carry `reason`)
- [x] 3.4 Identify the single `disposeSession(sessionId)` codepath in the server (create one if it doesn't exist) and fire `SessionEnd` from there
- [x] 3.5 Ensure post-event hook firings do not block the agent loop — schedule them on a queue so that a slow `PostToolUse` hook does not delay the next model turn

## 4. `@chimera/cli` integration

- [x] 4.1 Register a `hooks` subcommand group in the CLI
- [x] 4.2 Implement `chimera hooks list` that scans both directories and prints a tabular grouping by event, including events with no hooks (empty list under the heading)
- [x] 4.3 Implement `--json` output: a single JSON object `{ events: { <Event>: { global: string[], project: string[] } } }`
- [x] 4.4 Honor `--cwd <path>` for the project-scope directory; default to `process.cwd()`
- [x] 4.5 Reject unknown subcommands under `chimera hooks` with the standard "did you mean..." behavior

## 5. Tests

- [x] 5.1 `@chimera/hooks` unit tests: discovery returns executables only; non-executables and broken symlinks are skipped; ordering is global-first then lexicographic
- [x] 5.2 `@chimera/hooks` unit tests: payload shape per event; env vars are set; cwd is the session cwd
- [x] 5.3 `@chimera/hooks` unit tests: pre-event exit 2 reports block; pre-event exit 1 / timeout / spawn-failure does not block; post-event exit codes never block
- [x] 5.4 `@chimera/permissions` test: `GatedExecutor` denies a tool when the supplied `hookRunner` reports a `PermissionRequest` block; emits `permission_resolved` with `decision: "deny"`, `remembered: false`; tool result is `{ error: "denied by hook" }`
- [x] 5.5 `@chimera/permissions` test: `GatedExecutor` proceeds to the user prompt when the hook runner reports no block; existing prompt behavior is unchanged
- [x] 5.6 `@chimera/server` integration test: a `PostToolUse` script dropped into `<cwd>/.chimera/hooks/PostToolUse/` runs after a tool call, receives the expected JSON payload on stdin, and its non-zero exit does not abort the session
- [x] 5.7 `@chimera/server` integration test: a `SessionEnd` script fires exactly once when a session is disposed
- [x] 5.8 `@chimera/cli` test: `chimera hooks list` lists installed hooks and includes empty-list sections for events with none; `--json` emits a single valid JSON object

## 6. Docs

- [x] 6.1 Add a `docs/hooks.md` covering the directory layout, event list, payload shape, env vars, exit-code semantics, timeout, and trust model
- [x] 6.2 Add a short Legato integration recipe (drop-in script template) to that doc
- [x] 6.3 Cross-reference `docs/hooks.md` from the project README's extensibility section

## 7. Verification

- [x] 7.1 Run `pnpm -r build && pnpm -r test` and confirm green
- [x] 7.2 Manually drop the five Legato scripts (or stand-ins) into `~/.chimera/hooks/<Event>/` and confirm each fires once on its trigger
- [x] 7.3 Run `openspec validate add-lifecycle-hooks` and confirm no validation errors
