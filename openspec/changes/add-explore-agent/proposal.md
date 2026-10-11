## Why

A wide search fills the main context with file contents the agent reads once
and never needs again. Codex and Claude Code give such searches to a
read-only helper on a cheaper model and keep only its findings. Chimera has
`spawn_agent`, but no ready helper, no cheap model for helper work, and no
way to start a helper and continue working.

## What Changes

- Ship a built-in `explore` agent definition: read-only tools, findings with
  `path:line` references. A user definition with the same name has priority.
- Add a `utilityModel` config key: one low-cost model for helper work. An
  agent definition selects it with `model: utility`. Compaction uses it when
  `compaction.model` is not set. Without the key, helper work uses the
  session model.
- Tell the model, in the tool list of the system prompt, to give wide
  searches to `explore`.
- `spawn_agent` accepts `background: true`. The call returns an agent id at
  once. When the child finishes, Chimera puts its result into the parent
  conversation, and starts a run for it when the parent is idle.
- Add `agent_status` and `agent_stop` for background children. Chimera stops
  every background child when the session ends.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `subagents`: built-in definitions, the `utility` model alias, background
  children and their two tools.
- `cli`: the `utilityModel` config key.
- `tui`: how a background child shows in the transcript.

## Impact

- `packages/subagents`: `builtin/explore.md`, discovery, `spawn-tool.ts`, a
  background child manager, two tools.
- `packages/cli`: config key, factory wiring, compaction model fallback.
- `packages/core`: `subagent_spawned` gains an optional `background` flag;
  the agent gets a way to start a run from a queued message.
- `packages/tui`: transcript lines for background children.
- All event changes are additions.
