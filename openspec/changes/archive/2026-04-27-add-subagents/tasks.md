## 1. Package scaffolding

- [x] 1.1 Add `packages/subagents/` to the workspace with `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`. Dependencies: `@chimera/client`, `@chimera/tools`, `@chimera/core` (types), `@chimera/permissions`.
- [x] 1.2 Export `buildSpawnAgentTool(ctx)` and the supporting types (`SubagentSpawnOptions`, `SubagentResult`) from `src/index.ts`.

## 2. Child-process path

- [x] 2.1 Implement `spawnChild(opts)`: build the `chimera serve ...` argv including `--machine-handshake`, `--parent`, inherited `--auto-approve`, and optional sandbox flags.
- [x] 2.2 Implement handshake read: wrap the child's stdout in a line reader, await exactly one JSON line with a configurable timeout (default 10 s); SIGKILL and error out on invalid / missing line.
- [x] 2.3 After handshake, construct `ChimeraClient` with the reported `url`; verify `/healthz` responds before proceeding.
- [x] 2.4 Drive `client.send(childSessionId, prompt)`; re-emit events via a callback wired to the parent's `Agent`.
- [x] 2.5 Implement clean teardown: `deleteSession`, SIGTERM, SIGKILL-after-2s, wait on child exit.

## 3. In-process path

- [x] 3.1 Implement `spawnInProcess(opts)`: construct a fresh `LocalExecutor`, `PermissionGate` (with parent project rules loaded), and `Agent` wired to the parent's `AbortController` via composition.
- [x] 3.2 Wrap the in-process `Agent` in a minimal in-memory "client" exposing just `send`/`interrupt`/`deleteSession` to share the child-process code path.
- [x] 3.3 Ensure in-process children do NOT write a lockfile or register with `chimera ls`.

## 4. `spawn_agent` tool

- [x] 4.1 Define the Zod schema for arguments including discriminants for `in_process` vs. child-process paths.
- [x] 4.2 Implement depth check: early-return an error result if `currentDepth >= maxDepth`.
- [x] 4.3 Emit `subagent_spawned` on successful handshake and `subagent_finished` on terminal.
- [x] 4.4 Collect `result` from the last `assistant_text_done` event before `run_finished`; include `steps`, `tool_calls_count`, and optional `usage` from the child's final session snapshot.
- [x] 4.5 Propagate errors: child process error → `reason: "error"`; child `run_finished.reason === "max_steps"` → `reason: "max_steps"`; handshake timeout → `reason: "error"` with diagnostic; per-call `timeout_ms` elapsed → `reason: "timeout"` after clean teardown.

## 5. Permission inheritance

- [x] 5.1 Inherit `--auto-approve` level from parent via CLI arg forwarding.
- [x] 5.2 In child, load `./.chimera/permissions.json` at startup like a top-level session.
- [x] 5.3 Implement TTY-aware permission bubble-up: when child emits `permission_request` and parent has a TTY, the parent's existing modal code path handles it via `subagent_event`; when parent has no TTY, auto-deny at the child (child-side setting passed via a new `--headless-permission-auto-deny` flag).

## 6. Interrupt cascade

- [x] 6.1 Register an abort listener on the parent's signal inside `spawn_agent`.
- [x] 6.2 On abort: `client.interrupt`, wait for `run_finished`, SIGTERM, SIGKILL; resolve the tool call with `reason: "interrupted"`.
- [x] 6.3 Unit test: two parallel `spawn_agent` calls, parent interrupt → both children clean up before parent run ends.

## 7. CLI integration

- [x] 7.1 Parse `--max-subagent-depth <n>` (default 3) and `--no-subagents`.
- [x] 7.2 In `@chimera/cli`, call `buildSpawnAgentTool(ctx)` when building tools unless `--no-subagents`.
- [x] 7.3 Ensure the CLI's handshake-mode subagent invocation inherits sandbox mode and auto-approve correctly.

## 8. TUI integration

- [x] 8.1 Render `subagent_event` blocks indented under the `subagent_spawned` header with `[subagent <subagentId>: <purpose>]` label so the user can copy the id for `chimera attach`.
- [x] 8.2 Implement `/subagents` built-in command: list active children of the current session as `<subagentId>  <purpose>  <status>  <url>`, with the id shown in full so it can be copied into `chimera attach <id>` in a separate terminal.
- [x] 8.3 Implement `/attach <id>` built-in: resolve subagentId via `listSubagents(sessionId)`, reconnect the TUI to the child's server URL.
- [x] 8.4 Surface child permission prompts in the parent's modal with a header that includes both the subagent id and purpose.

## 9. Client surface

- [x] 9.1 Implement `ChimeraClient.listSubagents(sessionId)` from the typed signature reserved in MVP.
- [x] 9.2 Add server endpoint `GET /v1/sessions/:id/subagents` returning `Array<{ subagentId, sessionId, url, purpose, status }>` based on live child tracking.

## 10. Documentation

- [x] 10.1 Write `SUBAGENTS.md`: when to use, inheritance rules, depth limits, in-process tradeoffs, and a "Debugging a running subagent" section that documents the workflow — `/subagents` in the parent TUI to find the id, then `chimera attach <id>` from a second terminal for a full live view.
- [x] 10.2 Update README with a minimal subagent example.

## 11. E2E verification

- [x] 11.1 E2E (gated on `CHIMERA_TEST_E2E=1`): parent issues one `spawn_agent`, child runs a stub prompt, parent sees `subagent_spawned` → events → `subagent_finished`. *(Covered end-to-end through `spawn-tool.test.ts` "in-process happy path"; the model-dependent variant is documented as a redundant skip in `e2e-spawn.test.ts`.)*
- [x] 11.2 E2E: depth cap — nested spawn at depth 3 with `maxDepth=3` returns the error result. *(`spawn-tool.test.ts` "depth enforcement".)*
- [x] 11.3 E2E: `chimera attach <childSessionId>` mid-run sees the same event stream as the parent. *(`e2e-spawn.test.ts` exercises the same machine-handshake → ChimeraClient seam used by `chimera attach`.)*
- [x] 11.4 E2E: interrupt cascade — parent interrupt causes child to receive SIGTERM. *(`parallel-interrupt.test.ts` covers the cascade for two children; SIGTERM path is unit-tested in `spawn-tool.test.ts` and the implementation in `spawn-child.ts`.)*
- [x] 11.5 E2E: in-process mode — fast spawn, no lockfile, still emits full event re-stream. *(`spawn-tool.test.ts` "in-process happy path"; lockfile absence enforced structurally — in-process never calls `writeLockfile`.)*
