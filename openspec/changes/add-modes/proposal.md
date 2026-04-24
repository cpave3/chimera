## Why

`spec.md` §17 lists plan mode as a V1 non-goal, but it keeps coming up in `goal.md`'s "permission-aware by default" discussion and in the OpenCode/Claude-Code feature set users expect. Rather than ship "plan mode" as a one-off flag, we introduce **modes** as a first-class primitive — a Vim-like concept where the current mode determines what the agent sees in its system prompt and which tools are registered. Plan mode becomes the flagship instance; future modes (review, debug, notes, …) drop in as user markdown files with zero new machinery. This composes cleanly with skills and commands (all three are sibling file-based primitives with the same discovery story) and gives Chimera a multi-modal personality that is consistent, extensible, and user-governable.

## What Changes

- Introduce `@chimera/modes` with `loadModes({ cwd, userHome, includeClaudeCompat })` returning a `ModeRegistry`.
- Define the Mode file format: `.chimera/modes/<name>.md` with YAML frontmatter carrying exactly three configurable fields — `tools` (tool allowlist), `model` (optional provider/model override), plus metadata (`name`, `description`) — and a markdown body used as an appended prompt fragment.
- Share the six-tier discovery walker with skills/commands (Chimera project → ancestors → user home → `.claude/` compat triplet).
- Ship a built-in `plan` mode bundled as `@chimera/modes/builtin/plan.md`, overridable via the six-tier precedence.
- Ship a JSON Schema (`@chimera/modes/schema.json`) so editors with YAML LSP get autocomplete and inline validation of mode frontmatter.
- Implement a four-tier runtime validator (schema → tools-in-registry → provider-exists → opt-in live model probe) with "warn-on-discovery, error-on-use" semantics.
- Add `chimera modes` (list) and `chimera modes check [--live]` (validate) subcommands.
- Add `Session.mode` (persisted with the session snapshot) and `Session.userModelOverride` (sticky across mode switches).
- Extend the system-prompt composer to append `# Current mode: <name>` + the mode body after any `AGENTS.md` / skill index blocks.
- Filter the tool registry per turn via the current mode's allowlist: omitted = all; `[]` = none; listed = exactly those.
- Resolve the effective model per call as `userModelOverride ?? currentMode.model ?? config.defaultModel`.
- Implement mode switching: TUI `/mode <name>`, CLI `--mode <name>`, `defaultMode` config key, `Shift+Tab` cycles through `cycleModes` (default `["normal", "plan"]`). All switches are queued — they take effect on the next turn, not mid-run.
- Emit a new `mode_changed` event with `{ from, to, reason, effectiveModel, effectiveModelChanged }`.
- Extend `spawn_agent` (from `add-subagents`) with an optional `mode: string` argument; children default to `normal`, NOT to parent's mode.
- Extend command frontmatter (from `add-commands`) with an optional `mode:` field that triggers a persistent mode switch before the expanded message is sent.
- Add HTTP endpoints `POST /v1/sessions/:id/mode` (queue a switch) and `GET /v1/sessions/:id/modes` (list the session's loaded registry); client gains `setMode` and `listModes`.
- TUI header gains a `[mode:<name>]` badge (dim/hidden when normal); queued switches render `[mode:normal → plan]` until the current turn finishes.

## Capabilities

### New Capabilities

- `modes`: the Mode definition format, discovery, validation, system-prompt composition extension, tool-allowlist enforcement, model-resolution precedence, switching semantics (`/mode`, `--mode`, Shift+Tab cycle, queued mid-run), `mode_changed` event, built-in `plan` mode, CLI / SDK surface.

### Modified Capabilities

None formally. `agent-core`'s system-prompt extension point already exists (MVP reserved it for skills and, by extension, any similar follow-on). Integration into `cli`, `tui`, `agent-server`, `agent-sdk`, `subagents`, and `commands` is additive and described in Impact rather than as deltas to those capability specs — consistent with how `add-skills`, `add-commands`, etc. handle cross-package wiring.

## Impact

- **Prerequisites**: `chimera-mvp` applied and archived. Works on its own; `add-commands` and `add-subagents` integrations are soft-required (modes work without them; if present, they gain the documented fields).
- **Code changes outside the new package**:
  - `@chimera/core`: add `Session.mode: string | undefined` and `Session.userModelOverride: string | null` fields; serialize both in the snapshot; extend `composeSystemPrompt` to append the mode block; resolve the effective model per step using the precedence chain.
  - `@chimera/tools`: accept a `ToolContext.allowlist?: Set<string>` input and use it to filter the registered tool set on each step. MVP's `buildTools` today returns all tools; after this change it filters per call.
  - `@chimera/cli`: parse `--mode <name>` and `defaultMode` config; register `chimera modes` and `chimera modes check`; include the modes package in the session bootstrap.
  - `@chimera/tui`: render the `[mode:<name>]` badge in the header (hidden when normal); implement the `/mode` built-in dispatcher; bind Shift+Tab to cycle through `config.cycleModes`; render inline "mode switched" separators in the scrollback on `mode_changed`.
  - `@chimera/server`: expose `POST /v1/sessions/:id/mode` and `GET /v1/sessions/:id/modes`.
  - `@chimera/client`: add `setMode(sessionId, name)` and `listModes(sessionId)`.
  - `@chimera/subagents` (if installed): add `mode?: string` to the `spawn_agent` Zod schema; default `"normal"`; propagate to the child via an additional `--mode` CLI arg.
  - `@chimera/commands` (if installed): extend frontmatter schema with optional `mode: string`; when a user invokes a command with that field, queue the mode switch before sending the expanded message.
- **Backward compat**: existing MVP sessions without `Session.mode` deserialize with `mode: undefined` (normal). No persisted state schema break.
- **Filesystem**: reads from the same six tiers as skills/commands under `.chimera/modes/` and `.claude/modes/`; writes nothing.
