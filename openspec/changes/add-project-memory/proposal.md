## Why

Every session starts knowing only what the repository and its instruction
files say. A preference the user stated last week, or a correction to the
agent's approach, is gone. Codex and Claude Code keep such facts in a small
file-based memory for each project and load an index of it at session start.

## What Changes

- A memory directory for each project:
  `~/.chimera/projects/<project-id>/memory/`, with a `MEMORY.md` index and
  one file for each topic. All git worktrees of one repository share it.
- The first 200 lines of `MEMORY.md` go into the system prompt at session
  start, with the directory's path and the rules for saving.
- The file tools can read and write the directory. No new tool.
- With the `lean` prompt style the model saves a memory when the user states
  a lasting preference or corrects the approach. With the `guided` style it
  saves only when the user asks.
- Subagents can read the memory and cannot write it.
- `/memory` opens the index in `$EDITOR`.
- `memory.enabled` in the config, default `true`.

## Capabilities

### New Capabilities

- `project-memory`: where the memory lives, what a session loads, who can
  write it.

### Modified Capabilities

- `cli`: the `memory.enabled` config key.
- `tui`: the `/memory` command.

## Impact

- `packages/core`: project root and id, memory index reading, the prompt
  section.
- `packages/cli`: config key; factory grants path access and adds the
  section; `/memory` wiring.
- `packages/tui`: `/memory`; an editor handoff for a real file.
- New state under `~/.chimera/projects/`.
