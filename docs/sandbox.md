# Sandboxes

Chimera has two sandboxes. The OS sandbox is on by default and confines the
writes of host commands. The Docker sandbox is opt-in and moves the tools into
a container. An optional approval reviewer decreases the number of approval
prompts.

| | OS sandbox | Docker sandbox |
| --- | --- | --- |
| Default | On, when the machine has one | Off; `--sandbox` turns it on |
| What runs inside | Host `bash` commands | `bash` and the file tools |
| Reads | Everything | Only what the container has |
| Writes | The project, the temp directory, granted paths | The mode decides: `bind`, `overlay` or `ephemeral` |
| Needs | `bubblewrap` (Linux) or `sandbox-exec` (macOS) | Docker |

The approval rules for host commands are in
[Host bash command policy](bash-command-policy.md). The threat model is in
[`SECURITY.md`](../SECURITY.md).

## OS sandbox

Without `--sandbox`, each host `bash` command runs in the sandbox of the
operating system (`bubblewrap` on Linux, `sandbox-exec` on macOS) when the
machine has one. The command can read every file. It can write only in the
working directory, the temp directory, the session's write paths and the git
directory of the repository. It cannot write `.chimera/`, where the permission
rules and hooks are.

When the sandbox blocks a command, the model can ask to run it outside the
sandbox. That request needs user approval; the AI reviewer cannot grant it. The
[System One check](#system-one-check) can grant it only when its
`allowSandboxBypass` setting is on. An explicitly remembered
allow rule with `allowUnsandboxed: true` and an exact or simple-command prefix
pattern can grant the bypass, including in headless sessions. Ordinary allow
rules, glob rules and auto-approval cannot. Deny rules win, and other mandatory
findings still need approval. A prefix grant does not cover compound commands;
those need fresh approval. Trust the executable and its subcommands before
granting a prefix: they run without OS confinement. See
[Remembered sandbox bypass](bash-command-policy.md#remembered-sandbox-bypass).
The context panel shows
`sandbox os` while the OS sandbox is active.

For a recognized sandbox failure, Chimera retries the command once on the host
if an explicit saved bypass rule passes a fresh policy check, or if the System
One check with `allowSandboxBypass` approves the command. It does not prompt
or consult the AI reviewer for this retry. Normal failures, timeouts and cancelled
calls are not retried. Foreground retries share the original timeout budget;
background retries keep the same shell ID. Results include `sandbox_retry`
evidence and preserve the first attempt's diagnostics.

**A retry can repeat partial side effects.** The first attempt may have changed
files or external state before failing. Grant saved bypass rules only for commands
you trust to run again outside confinement.

In the bypass prompt, choose **Allow once** for one run, or **Allow exact command…**
to remember only the command shown. Choose **Allow command prefix…** to edit a
prefix such as `legato` or `legato plan`. Review the pattern, then select session,
project, or global scope. A session rule expires when that session ends.

```json
{
  "commandPolicy": {
    "hostBash": {
      "osSandbox": "auto",
      "network": "on",
      "sandboxWritePaths": ["~/.cache/pnpm"]
    }
  }
}
```

`osSandbox` is `auto` (default), `required` or `off`. `network: "off"` removes
network access from sandboxed commands. See
[Host bash command policy](bash-command-policy.md#os-sandbox) for the
rules and the limits. The macOS profile was not run on a Mac.

## Approval reviewer

```json
{ "approvalReviewer": { "enabled": true } }
```

The approval reviewer is off by default. When it is on, a host command or an
MCP call that needs your approval goes to the `utilityModel` first. The
reviewer reads the call, the policy findings, your messages and the project
instructions. It answers `allow` or `escalate`.

- `allow` runs the call. The tool line shows `approved by reviewer`.
- `escalate` opens the usual prompt, which shows the reviewer's reason.
- In a session that has nobody to ask, `escalate` is a denial. The model gets
  the reason.

Sandbox bypass requests, sudo commands and commands with a `danger` or `critical`
finding skip the reviewer. See
[Host bash command policy](bash-command-policy.md#approval-reviewer) for
the rules, the limits and the audit record.

## System One check

```json
{ "systemOne": { "enabled": true, "jev": { "apiKey": "env:JEV_API_KEY" } } }
```

The System One check is off by default. When it is on, a host bash command
that needs your approval goes first to a System One model (Jev, or a server
with its protocol). The model rates how safe the command is.

- A command at or above the `threshold` runs. The tool line shows
  `approved by System One`.
- A command below the threshold comes to you, with a note that the model
  rejected it.
- With `"allowSandboxBypass": true`, a command that the model approves can
  also leave the OS sandbox.

Sudo commands and commands with a `danger` or `critical` finding skip the
check. Each command that the model rates is in
`~/.chimera/logs/system-one-decisions.jsonl`. See
[Host bash command policy](bash-command-policy.md#system-one-check) for the
settings, the questions, the threshold and the limits.

## Docker sandbox

Tool calls can be routed through a Docker container instead of running directly
on the host. Three modes are available:

- `bind` (default with `--sandbox`) — bind-mounts the cwd read-write into the
  container; writes land on the host immediately.
- `overlay` — bind-mounts the cwd read-only and stacks an overlayfs upperdir
  at `~/.chimera/overlays/<sessionId>/`. Writes go to the upperdir, then the
  user reviews and applies them at session end.
- `ephemeral` — like overlay but with a tmpfs upperdir. Nothing persists.

Examples:

```
# Run a one-shot prompt inside a bind-mount sandbox.
chimera run --sandbox "fix the failing tests"

# Apply changes from an overlay run iff the agent finished cleanly.
chimera run --sandbox --sandbox-mode overlay --apply-on-success "refactor X"

# Disable network access and tighten resources.
chimera run --sandbox --sandbox-network none --sandbox-memory 1g --sandbox-cpus 1 "..."

# Refuse to silently fall back to bind when overlay isn't supported.
chimera --sandbox --sandbox-mode overlay --sandbox-strict
```

In overlay mode, the TUI exposes `/overlay` (list pending changes), `/apply`
(interactive picker → rsync), and `/discard`.

The default image depends on how Chimera was built:

- **A release** uses `ghcr.io/cpave3/chimera-sandbox:<its version>`, which
  the release workflow publishes with the binaries. The first `--sandbox`
  run pulls it. Without the registry (offline, say) it builds the image
  locally under that name instead, from the Dockerfile and entrypoint that
  ship inside the binary.
- **A build from source** (`dev`) uses `chimera-sandbox:dev`, built locally
  from `packages/sandbox/docker/`. Pre-build it with `pnpm sandbox:build`
  (or `chimera sandbox build`); otherwise the first `--sandbox` run builds
  it once.

`chimera sandbox build` writes the embedded build context to a temporary
directory and builds `chimera-sandbox:dev` from it, so it works from a
release binary too. Pass `--sandbox-image <ref>` to use a different image:
it is pulled if it is missing, but never built, so a typo errors at once.

Overlay/ephemeral modes need `CAP_SYS_ADMIN` and `--security-opt
apparmor=unconfined` on `docker run`. See [`SECURITY.md`](../SECURITY.md).

MCP calls run on the host in every mode. See [MCP tools](mcp.md).
