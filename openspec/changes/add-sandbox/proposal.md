## Why

`chimera-mvp` ships with a `LocalExecutor` only — every tool call runs on the host. `spec.md` §7 calls Docker sandboxing a defining property of Chimera: it is what makes `--auto-approve sandbox` meaningful, what enables the `overlay` review-before-apply flow, and what makes `chimera run` usable in automation on untrusted prompts. This change adds the `@chimera/sandbox` package and unlocks the `target: "sandbox"` routing that MVP tools already carry in their Zod schemas.

## What Changes

- Introduce `@chimera/sandbox` with a `DockerExecutor` implementing the existing `Executor` interface.
- Implement three sandbox modes from `spec.md` §7.1: `bind` (rw bind-mount of cwd), `overlay` (overlayfs upperdir persisted to `~/.chimera/overlays/<sessionId>/`), `ephemeral` (tmpfs upperdir, discarded at exit).
- Ship a default image reference (`ghcr.io/<org>/chimera-sandbox:<version>`, org TBD at release time) plus `packages/sandbox/docker/Dockerfile` and a `chimera sandbox build` subcommand for local builds.
- Implement the overlay diff-and-apply review flow (`rsync --dry-run` → TUI picker → `rsync -a`) and the non-TTY fallback (`--apply-on-success` or discard).
- Implement overlay fallback detection: if `CAP_SYS_ADMIN` / overlayfs unavailable, log a warning and fall back to `bind`; `--sandbox-strict` refuses fallback.
- Unlock the CLI flags from `spec.md` §7.7 that `chimera-mvp` currently rejects: `--sandbox`, `--sandbox-mode`, `--sandbox-strict`, `--sandbox-image`, `--sandbox-network`, `--sandbox-memory`, `--sandbox-cpus`, `--apply-on-success`.
- Wire sandbox-mode defaults per `spec.md` §7.7 (`--sandbox` defaults to `bind`; network allowed; 2g memory / 2 CPUs).
- Make `--auto-approve sandbox` functional (auto-approve sandbox-target calls, prompt on host-target calls).

## Capabilities

### New Capabilities

- `sandbox-execution`: `DockerExecutor`, container lifecycle (start / exec / file I/O / stop), mode-specific mount strategy, overlay entrypoint, diff-and-apply, fallback detection, default-image build path.

### Modified Capabilities

None. The MVP specs already describe `target`-aware routing and the `SandboxMode` field as forward-compat extension points; no existing requirement changes in meaning. Integration details (which CLI flags become accepted, which executor `buildTools` receives, which value `Session.sandboxMode` can hold) are described in Impact.

## Impact

- **Prerequisites**: `chimera-mvp` must be applied and archived. Runtime: Docker ≥ 20.10 on Linux with overlayfs (kernel ≥ 3.18); macOS/Windows Docker Desktop supported for `bind` only (overlay detection falls back automatically). `CAP_SYS_ADMIN` + `apparmor=unconfined` required for overlay; document `--privileged` as a fallback with a warning.
- **Code changes outside the new package**:
  - `@chimera/cli`: stop rejecting sandbox flags; parse them; wire `DockerExecutor` into `ToolContext.sandboxExecutor` when `--sandbox` is set; register the `chimera sandbox build` subcommand; run the overlay diff-and-apply flow at session end in overlay mode.
  - `@chimera/tools`: no spec change — `bash`'s existing `target` routing becomes reachable. Tool context must now set `sandboxExecutor` to `DockerExecutor` when sandbox is on.
  - `@chimera/permissions`: no spec change — the existing `--auto-approve sandbox` tier becomes functional because sandbox-target calls now happen.
  - `@chimera/tui`: add `/overlay`, `/apply`, `/discard` built-in slash commands (overlay mode only) per `spec.md` §14.3; render the `[sandbox:<mode>]` header badge with the real mode; render the overlay review picker.
  - `@chimera/server`: `GET /v1/instance.sandboxMode` now reports real values (`"bind"|"overlay"|"ephemeral"`), not only `"off"`.
- **Filesystem**: `~/.chimera/overlays/<sessionId>/{upper,work}` for overlay mode; a pulled or built Docker image for the default sandbox.
- **Security**: opens a large but well-scoped attack surface — document in `SECURITY.md` that the Docker daemon is part of the TCB (per `spec.md` §7.8).
