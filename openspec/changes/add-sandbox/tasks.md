## 1. Package scaffolding

- [x] 1.1 Add `packages/sandbox/` to the workspace with `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`.
- [x] 1.2 Extend the `SandboxMode` type in `@chimera/core` from `"off"` to `"off" | "bind" | "overlay" | "ephemeral"` (no spec change — MVP already reserved this).

## 2. DockerExecutor core

- [x] 2.1 Implement `DockerExecutor` class with `start()`, `stop()`, and the full `Executor` surface.
- [x] 2.2 Implement `exec()` via `docker exec -i ... sh -c` with timeout → SIGTERM → SIGKILL progression.
- [x] 2.3 Implement `readFile` / `readFileBytes` / `writeFile` via `docker exec ... cat` / `tee`.
- [x] 2.4 Implement `stat()` via `docker exec ... stat -c '%F|%s' <path>` parsing.
- [x] 2.5 Wire `AbortSignal` so `Agent.interrupt()` kills in-flight container processes.

## 3. Mode-specific mounting

- [x] 3.1 Implement `bind` mode: single `-v <cwd>:/workspace:rw` mount.
- [x] 3.2 Implement overlay entrypoint script (`packages/sandbox/docker/entrypoint.sh`) that runs `mount -t overlay` and execs `sleep infinity`.
- [x] 3.3 Implement `overlay` mode: create `~/.chimera/overlays/<sessionId>/{upper,work}`, pass `-v` mounts, `--cap-add SYS_ADMIN`, `--security-opt apparmor=unconfined`.
- [x] 3.4 Implement `ephemeral` mode: same as overlay but `--tmpfs /upper` instead of a host upperdir.

## 4. Overlay review flow

- [x] 4.1 Implement `diffOverlay(sessionId)` shelling to `rsync --dry-run -rln --delete` and parsing into `{ modified, added, deleted }`.
- [x] 4.2 Implement `applyOverlay(sessionId, selection)` running `rsync -a [--delete]` scoped to selected paths.
- [x] 4.3 Implement `discardOverlay(sessionId)` removing the upperdir tree.
- [x] 4.4 Implement "keep" semantics: `DockerExecutor.stop()` retains the upperdir; resuming with `--session <id>` re-mounts it.
- [x] 4.5 Unit tests against a temp cwd with fake upperdir layouts.

## 5. Fallback detection

- [x] 5.1 Implement probe logic inside `DockerExecutor.start()` — catch entrypoint non-zero, classify as overlay failure.
- [x] 5.2 Implement fallback path: rm failed container, restart in `bind`, emit warning log + stderr line.
- [x] 5.3 Implement `--sandbox-strict` refusal — throw from `start()`, CLI exits non-zero.

## 6. Default image

- [x] 6.1 Author `packages/sandbox/docker/Dockerfile` with Debian slim + tools listed in `sandbox-execution` spec.
- [x] 6.2 Implement `chimera sandbox build` subcommand in `@chimera/cli`.
- [x] 6.3 Resolve the image tag from `@chimera/cli` package version at runtime; `--sandbox-image` overrides.
- [ ] 6.4 (Release step, not code) Push initial `ghcr.io/<org>/chimera-sandbox:v<ver>` once the org is decided.

## 7. CLI integration

- [x] 7.1 Stop rejecting sandbox flags in `@chimera/cli`; parse them.
- [x] 7.2 When `--sandbox` is set, build `ToolContext.sandboxExecutor = new DockerExecutor(...)` and run its `start()` before the Agent runs; `stop()` at session end.
- [x] 7.3 Default `--sandbox-mode` to `bind`; wire `--sandbox-network`, `--sandbox-memory`, `--sandbox-cpus` through to `docker run`.
- [x] 7.4 Implement `--apply-on-success`: at `chimera run` exit in `overlay` mode, apply iff `run_finished.reason === "stop"`, otherwise discard.
- [x] 7.5 Flip `/v1/instance.sandboxMode` to report the real mode in the server.

## 8. Permissions wiring

- [x] 8.1 No code changes expected in `@chimera/permissions` — confirm via tests that `--auto-approve sandbox` now auto-approves sandbox-target calls and prompts on host-target calls.

## 9. TUI integration

- [x] 9.1 Update the header to render the real `[sandbox:<mode>]` badge.
- [x] 9.2 Add built-in slash commands: `/overlay` (show diff list), `/apply` (TUI picker + apply), `/discard`. Hide them when mode !== `overlay`.
- [x] 9.3 Render the overlay review picker as an Ink modal with checkbox multi-select.

## 10. Documentation

- [x] 10.1 Update `README.md` with `--sandbox` examples.
- [x] 10.2 Add `SECURITY.md` noting Docker daemon is part of TCB per `spec.md` §7.8.
- [x] 10.3 Document `CAP_SYS_ADMIN` + `apparmor=unconfined` requirement and `--privileged` fallback.

## 11. E2E verification

- [x] 11.1 E2E (gated on `CHIMERA_TEST_DOCKER=1`): `chimera run --sandbox` with a stub model issuing one bash call inside the sandbox.
- [x] 11.2 E2E (gated): `--sandbox-mode overlay --apply-on-success` with a run that writes a file, then assert the file appears on the host.
- [x] 11.3 E2E (gated): `--sandbox-mode overlay` with `run_finished.reason === "error"` + `--apply-on-success` — assert file does NOT appear.
- [x] 11.4 E2E (gated): `--sandbox-mode ephemeral` — assert tmpfs, no upperdir written.
- [x] 11.5 Document manual verification steps for overlay fallback on a Docker Desktop host.
