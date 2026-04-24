## Why

`spec.md` §9 defines skills as model-invoked capabilities declared in `.chimera/skills/<name>/SKILL.md` files with YAML frontmatter, discovered at session start, indexed in the system prompt, and activated on demand when the model reads the SKILL.md. This matches Pi's and Claude Code's blank-canvas philosophy: Chimera ships zero built-in skills but knows how to find and surface whatever a project or user has written. `chimera-mvp` left the system-prompt composition extensible for exactly this purpose and claude-compat discovery paths are called out but not implemented.

## What Changes

- Introduce `@chimera/skills` with a `loadSkills({ cwd, userHome, includeClaudeCompat })` function returning a `SkillRegistry`.
- Implement the six-tier discovery path chain per `spec.md` §9.2 (Chimera cwd, Chimera ancestor walk, Chimera user home, then the three parallel `.claude/` compat paths) with name-collision resolution: closer beats farther, Chimera beats Claude-compat.
- Parse YAML frontmatter (required fields `name`, `description`; optional `version`, `license`); warn on invalid files and skip them.
- Build a compact system-prompt index (name, description, path — not full content) and append it to the system prompt via the extension point `@chimera/core` exposed in MVP.
- Track skill activation: when the `read` tool's path matches a known SKILL.md, emit `skill_activated { skillName, source }` purely for observability per `spec.md` §9.5.
- Unlock CLI flags `--no-skills` (skip discovery and injection entirely) and `--no-claude-compat` (skip the three `.claude/` tiers).
- Add `chimera skills` subcommand printing the resolved skill registry.
- Add server endpoint `GET /v1/sessions/:id/skills` and SDK method `listSkills(sessionId)` (already typed in MVP).
- Render a `📚 skill: <name>` indicator in the TUI on the `tool_call_start` that triggered activation.

## Capabilities

### New Capabilities

- `skills`: discovery path resolution, YAML frontmatter parsing, system-prompt index generation, activation detection, CLI/SDK surface for listing skills.

### Modified Capabilities

None. MVP's `agent-core` explicitly exposes a composition extension point so the skill index can be appended without modifying core internals. MVP's `agent-sdk` already types `listSkills` — this change wires it up server-side.

## Impact

- **Prerequisites**: `chimera-mvp` applied and archived.
- **Code changes outside the new package**:
  - `@chimera/core`: consume the registered system-prompt extension (no new API surface, just a call through).
  - `@chimera/cli`: load the registry once per session and pass the index string to the Agent; reject `--no-skills` gracefully if skills is disabled in config; register `chimera skills` subcommand.
  - `@chimera/server`: expose `GET /v1/sessions/:id/skills`.
  - `@chimera/tools`: after a `read` tool call completes, compare the resolved path to the skill index; if matched, emit `skill_activated`. No behavior change to `read` itself.
  - `@chimera/tui`: render the activation indicator.
- **Filesystem**: reads from `<cwd>/.chimera/skills/`, ancestors up to git root, `~/.chimera/skills/`, and the three `.claude/skills/` mirrors. Writes nothing.
- **Backward compat**: zero — MVP ships with no skills and nothing references them.
