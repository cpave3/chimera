## 1. Package scaffolding

- [ ] 1.1 Add `packages/subagents/` to the workspace with `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`. Dependencies: `@chimera/client`, `@chimera/tools`, `@chimera/core` (types), `@chimera/permissions`.
- [ ] 1.2 Export `buildSpawnAgentTool(ctx)` and the supporting types (`SubagentSpawnOptions`, `SubagentResult`) from `src/index.ts`.

## 2. Child-process path

- [ ] 2.1 Implement `spawnChild(opts)`: build the `chimera serve ...` argv including `--machine-handshake`, `--parent`, inherited `--auto-approve`, and optional sandbox flags.
- [ ] 2.2 Implement handshake read: wrap the child's stdout in a line reader, await exactly one JSON line with a configurable timeout (default 10 s); SIGKILL and error out on invalid / missing line.
- [ ] 2.3 After handshake, construct `ChimeraClient` with the reported `url`; verify `/healthz` responds before proceeding.
- [ ] 2.4 Drive `client.send(childSessionId, prompt)`; re-emit events via a callback wired to the parent's `Agent`.
- [ ] 2.5 Implement clean teardown: `deleteSession`, SIGTERM, SIGKILL-after-2s, wait on child exit.

## 3. In-process path

- [ ] 3.1 Implement `spawnInProcess(opts)`: construct a fresh `LocalExecutor`, `PermissionGate` (with parent project rules loaded), and `Agent` wired to the parent's `AbortController` via composition.
- [ ] 3.2 Wrap the in-process `Agent` in a minimal in-memory "client" exposing just `send`/`interrupt`/`deleteSession` to share the child-process code path.
- [ ] 3.3 Ensure in-process children do NOT write a lockfile or register with `chimera ls`.

## 4. `spawn_agent` tool

- [ ] 4.1 Define the Zod schema for arguments including discriminants for `in_process` vs. child-process paths.
- [ ] 4.2 Implement depth check: early-return an error result if `currentDepth >= maxDepth`.
- [ ] 4.3 Emit `subagent_spawned` on successful handshake and `subagent_finished` on terminal.
- [ ] 4.4 Collect `result` from the last `assistant_text_done` event before `run_finished`; include `steps`, `tool_calls_count`, and optional `usage` from the child's final session snapshot.
- [ ] 4.5 Propagate errors: child process error → `reason: "error"`; child `run_finished.reason === "max_steps"` → `reason: "max_steps"`; handshake timeout → `reason: "error"` with diagnostic; per-call `timeout_ms` elapsed → `reason: "timeout"` after clean teardown.

## 5. Permission inheritance

- [ ] 5.1 Inherit `--auto-approve` level from parent via CLI arg forwarding.
- [ ] 5.2 In child, load `./.chimera/permissions.json` at startup like a top-level session.
- [ ] 5.3 Implement TTY-aware permission bubble-up: when child emits `permission_request` and parent has a TTY, the parent's existing modal code path handles it via `subagent_event`; when parent has no TTY, auto-deny at the child (child-side setting passed via a new `--headless-permission-auto-deny` flag).

## 6. Interrupt cascade

- [ ] 6.1 Register an abort listener on the parent's signal inside `spawn_agent`.
- [ ] 6.2 On abort: `client.interrupt`, wait for `run_finished`, SIGTERM, SIGKILL; resolve the tool call with `reason: "interrupted"`.
- [ ] 6.3 Unit test: two parallel `spawn_agent` calls, parent interrupt → both children clean up before parent run ends.

## 7. CLI integration

- [ ] 7.1 Parse `--max-subagent-depth <n>` (default 3) and `--no-subagents`.
- [ ] 7.2 In `@chimera/cli`, call `buildSpawnAgentTool(ctx)` when building tools unless `--no-subagents`.
- [ ] 7.3 Ensure the CLI's handshake-mode subagent invocation inherits sandbox mode and auto-approve correctly.

## 8. TUI integration

- [ ] 8.1 Render `subagent_event` blocks indented under the `subagent_spawned` header with `[subagent: <purpose>]` label.
- [ ] 8.2 Implement `/subagents` built-in command (list active children of the current session).
- [ ] 8.3 Implement `/attach <id>` built-in: resolve subagentId via `listSubagents(sessionId)`, reconnect the TUI to the child's server URL.
- [ ] 8.4 Surface child permission prompts in the parent's modal with the subagent-purpose header.

## 9. Client surface

- [ ] 9.1 Implement `ChimeraClient.listSubagents(sessionId)` from the typed signature reserved in MVP.
- [ ] 9.2 Add server endpoint `GET /v1/sessions/:id/subagents` returning `Array<{ subagentId, sessionId, url, purpose, status }>` based on live child tracking.

## 10. Documentation

- [ ] 10.1 Write `SUBAGENTS.md`: when to use, inheritance rules, depth limits, in-process tradeoffs.
- [ ] 10.2 Update README with a minimal subagent example.

## 11. E2E verification

- [ ] 11.1 E2E (gated on `CHIMERA_TEST_E2E=1`): parent issues one `spawn_agent`, child runs a stub prompt, parent sees `subagent_spawned` → events → `subagent_finished`.
- [ ] 11.2 E2E: depth cap — nested spawn at depth 3 with `maxDepth=3` returns the error result.
- [ ] 11.3 E2E: `chimera attach <childSessionId>` mid-run sees the same event stream as the parent.
- [ ] 11.4 E2E: interrupt cascade — parent interrupt causes child to receive SIGTERM.
- [ ] 11.5 E2E: in-process mode — fast spawn, no lockfile, still emits full event re-stream.
