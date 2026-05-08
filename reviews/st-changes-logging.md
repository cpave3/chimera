# Error-handling visibility and permission-gate bug fix

## Files modified

### Client
- `packages/client/src/sse.ts` — Added `console.debug` to reader cancel/release catch blocks.

### Core
- `packages/core/src/interfaces.ts` — Added optional `toolName` to `ExecOptions`.
- `packages/core/src/persistence.ts` — Added `console.debug` to empty catches in `countLines` and `listSessionsOnDisk`.

### Permissions
- `packages/permissions/src/gated-executor.ts` — Fixed hardcoded `tool: 'bash'`: reads `opts.toolName ?? 'bash'`.
- `packages/permissions/src/rule-store.ts` — Added `console.warn` on `permissions.json` parse failure (logs path and message).
- `packages/permissions/test/gated-executor.test.ts` — Added 4 tests verifying `toolName` default, forwarding, and tool-specific rule matching.

### Sandbox
- `packages/sandbox/src/docker-runner.ts` — Narrowed kill catch blocks: logs `EPERM` at debug, silently ignores `ESRCH`.

### Server
- `packages/server/src/agent-registry.ts` — Added `console.debug` in `delete()` catch blocks for `activeRun` and `SessionEnd` hook.
- `packages/server/src/event-bus.ts` — Added `console.debug` in subscriber catch block.

### Tools
- `packages/tools/src/glob.ts` — Passes `toolName: 'glob'` into `sandboxExecutor.exec`.
- `packages/tools/src/grep.ts` — Passes `toolName: 'grep'` into `sandboxExecutor.exec`.
- `packages/tools/src/local-executor.ts` — Narrowed kill catch blocks: logs `EPERM` at debug, silently ignores `ESRCH`.

## Summary of behavioral changes

1. **Empty catches are now visible**: Every empty catch block identified by the review now logs at `debug` level (or `warn` for rule-store parse errors). In trace mode (`--verbose`, or when `console.debug` is unhidden) these failures become observable.
2. **EPERM is surfaced**: In both `docker-runner.ts` and `local-executor.ts`, child-kill failures now verify error code. Only `ESRCH` (process already gone, benign) is silently swallowed. `EPERM` (caller lacks permission to signal) logs at debug so it shows up in traces.
3. **GatedExecutor uses correct tool name**: Previously every tool that used `exec` internally went through the gate as `tool: 'bash'`, so rules targeting `glob` or `grep` never matched. `GatedExecutor.exec` now reads `opts.toolName` (added to `core/src/interfaces.ts::ExecOptions`), and `glob.ts`/`grep.ts` pass their own names. Rules now match correctly.
4. **Rule-store parse errors are audible**: A corrupted `.chimera/permissions.json` no longer silently drops the user's rules; it logs a warning with the file path.

## Caveats / follow-ups

- The `server/test/app.test.ts` pre-existing failures (4 tests around mode/permissions validation expecting 400 but getting 409) are caused by `server/src/app.ts` logic outside this subtask's scope, and were explicitly excluded from modification.
- `console.debug` / `console.warn` are used because these packages (client, core, permissions, sandbox, server) have no shared logger dependency. A follow-up could introduce a lightweight `debug(tag, ...)` utility in `@chimera/core` to unify these messages across the codebase.
- The `bash` tool (`tools/src/bash.ts`) has its own standalone permission-gate request (via `ctx.permissionGate.request`) and already passes `tool: 'bash'`. No change was needed there.
- Docker E2E tests are gated on `CHIMERA_TEST_DOCKER=1`; the `docker-runner.ts` kill-narrowing was verified by unit tests only.
