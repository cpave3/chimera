## Why

Chimera loads `AGENTS.md` from the working directory upward, but a package
deeper in a monorepo often has its own instructions that the agent never
sees. An instruction file of any size goes into every request. A large skill
library puts a long index into every request too. And plan mode can read
files but cannot look anything up on the web or hand a wide search to a
helper.

## What Changes

- **Nested instructions.** The first time a file tool touches a file in a
  directory below the working directory that has `AGENTS.md` or `CLAUDE.md`,
  the tool result carries that file. The system prompt does not change, so
  the provider cache stays valid.
- **Size limit.** An instruction file contributes at most 32 KiB. The
  interactive TUI says so when a file was cut.
- **Prompt.** The sentence that tells the model to go and read `AGENTS.md`
  is removed; Chimera supplies those files.
- **Skill index limit.** The index takes at most 2% of the context window.
  Over that, it lists skill names by directory, without descriptions.
- **Plan mode.** It gains `fetch`, `web_search` and `spawn_agent` limited to
  the `explore` agent. Mode files can limit a tool with `name(limit)`.
- **Not done:** `bash` in plan mode. The plan made it depend on the command
  classifier's `safe` level excluding file writes. It does not: `touch`,
  `cp`, `sed -i`, a redirect and `git commit` all rate `safe`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-core`: instruction file size limit; role prompt wording.
- `tool-execution`: nested instruction files in file tool results; tool
  limits from the active mode.
- `skills`: index size limit.
- `tui`: startup notice for a cut instruction file.

## Impact

- `packages/core`: prompt composition, instruction file reading.
- `packages/tools`: a `nestedInstructions` interceptor.
- `packages/skills`: `buildIndex` takes a token limit.
- `packages/modes`: tool limit syntax; built-in `plan.md`.
- `packages/subagents`: `spawn_agent` honours an agent limit.
- `packages/cli`: wiring; startup notices for the TUI.
