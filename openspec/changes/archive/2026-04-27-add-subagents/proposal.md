## Why

`spec.md` §11 defines subagents as nested Chimera instances driven through the SDK — no separate abstraction, just `chimera serve` + `ChimeraClient` orchestrated by a `spawn_agent` tool. This is the "dogfooding payoff": every introspection tool (`chimera ls`, `chimera attach`, lockfiles, event stream) works on subagents for free. `chimera-mvp` pre-wired the pieces that make this additive (machine handshake, subagent event variants, `--parent` server flag) but did not register the tool or manage child processes. This change turns the pre-wiring into a working feature.

## What Changes

- Introduce `@chimera/subagents` with a `buildSpawnAgentTool(ctx)` factory that returns a standard AI-SDK tool.
- Implement child-process lifecycle: spawn `chimera serve --machine-handshake [--sandbox ...] --auto-approve <inherited> --parent <parentSessionId>`, read the single-line JSON handshake, construct a `ChimeraClient`, stream `send()`, re-emit every child event as `subagent_event`, clean up with SIGTERM then SIGKILL.
- Implement in-process mode (`in_process: true`): instantiate a new `Agent` directly, wrap it in an in-memory client, avoid the handshake altogether. Per `spec.md` §11.5, default remains child-process for attachability.
- Enforce nesting depth (default 3, configurable via `--max-subagent-depth`).
- Implement interrupt cascade: `Agent.interrupt()` on the parent aborts in-flight child runs via `client.interrupt()` + SIGTERM.
- Implement permission inheritance per `spec.md` §11.3: child inherits parent's `--auto-approve` and loads parent's project-scope rules file. When the parent has no TTY, host-target permission requests in children auto-deny in MVP (V2 adds the proper bubble-up chain).
- Unlock CLI flags `--max-subagent-depth <n>` and `--no-subagents`; when `--no-subagents` is passed, the tool is not registered.
- Wire TUI rendering: nested tree-style block for subagent events, `/attach <id>` and `/subagents` built-in slash commands.
- Register subagent lockfiles so `chimera ls` shows them (flagged with `parentId`).

## Capabilities

### New Capabilities

- `subagents`: `spawn_agent` tool, child-process and in-process spawn paths, depth enforcement, interrupt cascade, permission inheritance rules, subagent observability integration.

### Modified Capabilities

None. MVP already defined the subagent variants of `AgentEvent` (`subagent_spawned`, `subagent_event`, `subagent_finished`), the `chimera serve --machine-handshake` and `--parent` flags, and the `PermissionGate` surface needed for inheritance. This change exercises those, not changes them.

## Impact

- **Prerequisites**: `chimera-mvp` applied and archived. Works with or without `add-sandbox` — if `add-sandbox` is applied, children can inherit sandbox mode; if not, children run host-local like their parents.
- **Code changes outside the new package**:
  - `@chimera/cli`: call `buildSpawnAgentTool` when building tools (unless `--no-subagents`); parse `--max-subagent-depth`.
  - `@chimera/tui`: render `subagent_event` sub-streams indented; implement `/attach <id>` (resolves id via `chimera ls`-style lockfile scan, switches TUI to the child's server URL); implement `/subagents` (list active children); when a child emits `permission_request`, surface it in the parent's modal with a "[subagent: <purpose>]" header.
  - `@chimera/client`: add `listSubagents(sessionId)` per `spec.md` §13.1 so consumers can walk the tree.
- **Filesystem**: subagent lockfiles coexist with parent lockfiles under `~/.chimera/instances/`. Logs gain a `subagent_of: <parent-id>` field.
- **Security**: `--auto-approve` inheritance could surprise users who expected "the child is safer by default." Documented in `SUBAGENTS.md`. Users who want tighter child policy pass explicit flags to `spawn_agent`.
