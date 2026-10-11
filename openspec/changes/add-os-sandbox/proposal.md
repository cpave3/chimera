## Why

Host commands run with the user's full rights. The command policy reads a
command before it runs and prompts for what looks dangerous, but static
analysis cannot see what a script or a downloaded program does. The user
either approves many prompts or raises auto-approval and trusts the model.
Codex and Claude Code run commands in an OS sandbox instead, so the kernel
holds the line and most prompts go away.

## What Changes

- Host `bash` commands, foreground and background, run in an OS sandbox:
  `bwrap` on Linux, `sandbox-exec` on macOS. The command reads everything and
  writes only in the working directory, the temp directory and granted write
  paths. `~/.chimera` and `<cwd>/.chimera` are read-only, so a command cannot
  change the agent's rules or install a hook.
- `commandPolicy.hostBash.network: "off"` removes network access.
- In the sandbox, a command whose only findings are about file paths runs
  with no prompt. Sudo and risk findings still need approval.
- A command the sandbox blocked says so in its result. The model can ask to
  run it unsandboxed with a reason; that request always goes to the user.
- `commandPolicy.hostBash.osSandbox`: `off`, `auto` (default) or `required`.
  `auto` uses the sandbox when it works and warns once when it does not;
  `required` refuses host commands without it.
- `commandPolicy.hostBash.sandboxWritePaths` adds writable directories (a
  package manager's store, for example).
- The file tools refuse to write `<cwd>/.chimera/permissions.json` and
  `<cwd>/.chimera/hooks/` while the sandbox is active.
- Docker sandbox modes and MCP calls are unchanged.
- macOS: the profile is generated and unit-tested. It was not run on a Mac.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tool-execution`: sandboxed host commands, the unsandboxed request, the
  blocked-command note.
- `permissions`: path findings in the sandbox; the unsandboxed approval.
- `cli`: the three config keys.

## Impact

- `packages/tools`: `os-sandbox.ts`, the bash tool, the background process
  manager, a write-deny list in `LocalExecutor`.
- `packages/core`: two fields on `PermissionRequest`.
- `packages/permissions`: the gate.
- `packages/cli`: config, detection and wiring in the factory.
