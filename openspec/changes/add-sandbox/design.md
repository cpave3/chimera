## Context

`chimera-mvp` left `SandboxMode = "off"` and made tool schemas forward-compat for a `target: "sandbox"` path. This change fills that path with a real Docker-backed `Executor`. The design follows `spec.md` §7 closely — the goal here is to document the small set of decisions that §7 leaves open.

## Goals / Non-Goals

**Goals:**

- One `Executor` implementation (`DockerExecutor`) covering all three modes, selected at container-start via mount args and entrypoint.
- Overlay review UX identical in TUI and headless (`--apply-on-success`) per `spec.md` §7.4.
- Fail gracefully on hosts without overlayfs; refuse gracefully under `--sandbox-strict`.
- Stable image reference so that published releases pin an exact tag.

**Non-Goals:**

- Non-Docker runtimes (Podman, nerdctl). Leave the `Executor` seam intact so a later `add-podman-sandbox` can slot in.
- Egress allowlists (`spec.md` §17 V1 non-goal).
- Resource quotas beyond `--memory` / `--cpus`.
- Per-tool sandbox routing for `read`/`write`/`edit`. Per `spec.md` §6.4, only `bash` has a `target` parameter; file tools always use `sandboxExecutor` when sandbox is on.

## Decisions

### D1. DockerExecutor proxies via `docker exec`, not a helper binary

**Decision:** Start a long-lived `sleep infinity` container; implement `exec` via `docker exec -i`, `readFile` via `docker exec ... cat`, `writeFile` via `docker exec -i ... tee`. Stop with `docker rm -f`.

**Why:** Matches `spec.md` §7.2. Zero in-container agent to maintain. The perf cost of one `docker exec` fork per call is dominated by model latency.

**Trade-off:** `writeFile` of large binaries through `docker exec -i ... tee` is slower than a volume copy, but file writes from the model are small in practice.

### D2. Overlay mount happens inside the container, not on the host

**Decision:** Mount `<hostCwd>:/lower:ro` + `<upperdir>:/upper`, then let the container's entrypoint `mount -t overlay` them onto `/workspace`. For `ephemeral`, `/upper` is backed by tmpfs declared on `docker run`.

**Why:** Keeps the host's mount table clean and sidesteps permission issues around host-side overlay.

**Cost:** Requires `CAP_SYS_ADMIN` + `apparmor=unconfined`. Documented and detected.

### D3. Diff-and-apply uses `rsync`, not git

**Decision:** At session end in `overlay` mode, compute changes with `rsync --dry-run -rln --delete <upperdir>/ <hostCwd>/`, present grouped as `modified`/`added`/`deleted`, then apply with `rsync -a [--delete]`.

**Why:** `spec.md` §7.4 specifies rsync. It handles binary files, preserves permissions, and doesn't require the cwd to be a git repo.

**Alternative considered:** `git diff` between trees. Rejected — requires cwd to be a git repo and fights with the agent's own git operations during the session.

### D4. Overlay fallback is detected on `start()`, not ahead of time

**Decision:** When `--sandbox-mode overlay` (or `ephemeral`), `DockerExecutor.start()` tries the overlay mount; on failure it falls back to `bind`, emits a warning event, and continues. `--sandbox-strict` turns the fallback into a hard error.

**Why:** Detecting overlay support pre-flight is unreliable across Docker Desktop, rootless, and AppArmor variants. A live probe is ground truth.

### D5. Image pinning

**Decision:** Default image is `ghcr.io/<org>/chimera-sandbox:v<major>.<minor>` — pinned to a minor version of Chimera itself. `chimera sandbox build` produces a locally-tagged `chimera-sandbox:dev` usable via `--sandbox-image`.

**Why:** Users should not float on `:latest`. Version-aligning the image to Chimera's minor version means a `chimera` upgrade pulls the matching image.

**Open:** Namespace owner — tracked as an MVP-era question from `spec.md` §20; not blocking this change structurally, blocking only the publish step.

### D6. CAP_SYS_ADMIN scope

**Decision:** Add `--cap-add SYS_ADMIN --security-opt apparmor=unconfined` only when the session uses `overlay` or `ephemeral`. `bind` mode runs with default capabilities.

**Why:** Principle of least privilege. Users who stick to `bind` don't pay the AppArmor relaxation cost.

## Risks / Trade-offs

- **[Docker Desktop macOS/WSL2 overlay quirks]** → fallback to `bind` with a warning; document that full overlay is Linux-primary.
- **[Large bind-mount volumes slow container start]** → `spec.md` §7.7 already acknowledges this; no mitigation in this change.
- **[`.git/` in overlay grows upperdir fast under `git gc`]** → documented; no special-case in this change per `spec.md` §20.
- **[rsync required on host]** → prerequisite documented; we do not ship rsync, we require it.

## Migration Plan

Additive: `chimera` upgrades install the new package; existing sessions remain `sandboxMode: "off"`. No on-disk migration needed. Rollback is `git revert` — no state schemas change.

## Open Questions

- GHCR org ownership (still open from `spec.md` §20). Block the release, not the implementation.
- Should `chimera serve --sandbox-mode overlay` auto-apply when the client disconnects without choosing? Proposed: **no**, mirror `chimera run` default which is `discard` unless `--apply-on-success` is passed. Revisit after user feedback.
