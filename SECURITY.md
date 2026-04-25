# Security

## Threat model

Chimera runs LLM-generated tool calls on a developer machine. The host is
trusted; the model is not. The permission gate exists to keep model-driven
shell calls from leaving the agent's controlled scope without an explicit
human "allow."

## Sandbox

When `--sandbox` is set, tool calls route through a Docker container. The
**Docker daemon is part of the trusted computing base.** Compromising
`dockerd` (or its socket) defeats the sandbox. Run Chimera on a machine where
Docker is already trusted by the developer.

### Capabilities

| Mode        | Capabilities                                              |
| ----------- | --------------------------------------------------------- |
| `bind`      | Default Docker capabilities; rw bind-mount of cwd.        |
| `overlay`   | `--cap-add SYS_ADMIN --security-opt apparmor=unconfined`. |
| `ephemeral` | Same as `overlay` (overlayfs requires SYS_ADMIN).         |

Overlay and ephemeral modes need `CAP_SYS_ADMIN` so the container's
entrypoint can `mount -t overlay` onto `/workspace`. AppArmor must be
unconfined for the same reason; on hosts where AppArmor is the only option
to relax, you may instead pass `--privileged` (broader; not recommended).

### Fallback

When `--sandbox-mode overlay|ephemeral` is requested on a host without
overlayfs support (e.g. macOS Docker Desktop, some rootless setups),
`DockerExecutor.start()` detects the failure at startup, removes the failed
container, and retries in `bind` mode. A warning is written to stderr and
to the session log. To refuse fallback (CI, security-sensitive runs), pass
`--sandbox-strict` — the CLI exits non-zero instead.

### Network

Default sandbox network is the standard Docker bridge (network on). Pass
`--sandbox-network none` to deny outbound traffic. Egress allowlists are
not yet supported.

### Resource limits

`--sandbox-memory <size>` (default `2g`) and `--sandbox-cpus <n>` (default
`2`) translate directly to `docker run --memory` / `--cpus`.

## Manual verification: overlay fallback on Docker Desktop

Docker Desktop on macOS / Windows / WSL2 frequently rejects `mount -t
overlay` inside containers (kernel modules are not exposed). Verify that
Chimera's fallback path works there:

1. Build the local image: `chimera sandbox build`.
2. Run with overlay requested (the bare command opens the interactive TUI;
   for a one-shot smoke test use `run`):

   ```
   chimera run --sandbox --sandbox-mode overlay "echo verify"
   ```

3. Confirm stderr contains a single line beginning with `sandbox: overlay
   unavailable (...); falling back to bind mode.`
4. Confirm the TUI status bar shows `[sandbox:bind]`, not `[sandbox:overlay]`.
5. Re-run with `--sandbox-strict`: the CLI should exit with a non-zero
   status and stderr should explain the failure without falling back.

## What is NOT in scope

- Egress allowlists / DNS filtering.
- Per-tool sandbox routing for `read`/`write`/`edit` (file tools always use
  the sandbox executor when sandbox is on).
- Hardening against compromised model output that targets the host through
  a sandboxed bash call: that's exactly what the `target='host'` permission
  prompt is for.
