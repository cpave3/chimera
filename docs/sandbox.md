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
sandbox. That request needs user approval; the AI reviewer cannot grant it. An explicitly remembered
allow rule with `allowUnsandboxed: true` and an exact or simple-command prefix
pattern can grant the bypass, including in headless sessions. Ordinary allow
rules, glob rules and auto-approval cannot. Deny rules win, and other mandatory
findings still need approval. A prefix grant does not cover compound commands;
those need fresh approval. Trust the executable and its subcommands before
granting a prefix: they run without OS confinement. See
[Remembered sandbox bypass](bash-command-policy.md#remembered-sandbox-bypass).
The context panel shows
`sandbox os` while the OS sandbox is active.

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

The default image is `chimera-sandbox:dev`, built locally from
`packages/sandbox/docker/`. Pre-build it with `pnpm sandbox:build` (or
`chimera sandbox build`); otherwise the first `--sandbox` invocation
auto-builds it once. Pass `--sandbox-image <ref>` to use a different image
— there's no auto-build for non-default tags, so a typo errors immediately.

Overlay/ephemeral modes need `CAP_SYS_ADMIN` and `--security-opt
apparmor=unconfined` on `docker run`. See [`SECURITY.md`](../SECURITY.md).

MCP calls run on the host in every mode. See [MCP tools](mcp.md).
