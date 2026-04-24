## ADDED Requirements

### Requirement: Skill file format

A skill is a directory `<root>/<name>/SKILL.md` where `<name>` is a unique identifier and `SKILL.md` is a UTF-8 text file whose first block SHALL be YAML frontmatter delimited by `---` lines. The frontmatter SHALL contain at minimum:

- `name`: string — must equal the directory name.
- `description`: string — one sentence about when to use the skill.

Optional frontmatter fields (`version`, `license`) SHALL be preserved on the registry entry. The body after the frontmatter is arbitrary markdown and SHALL NOT be parsed.

#### Scenario: Valid skill parsed

- **WHEN** `.chimera/skills/pdf/SKILL.md` exists with frontmatter `name: pdf` and `description: "Manipulate PDF files"`
- **THEN** `loadSkills` SHALL return a registry whose `find("pdf")` returns `{ name: "pdf", description: "Manipulate PDF files", path: <absolute path>, source: "project", frontmatter: { ... } }`

#### Scenario: Invalid frontmatter skipped

- **WHEN** `.chimera/skills/broken/SKILL.md` has malformed YAML or missing `description`
- **THEN** `loadSkills` SHALL omit `broken` from the registry, SHALL log one warning line naming the file and the parse error, and SHALL NOT throw

### Requirement: Discovery paths

`loadSkills({ cwd, userHome, includeClaudeCompat })` SHALL search, in this priority order:

1. `<cwd>/.chimera/skills/<name>/SKILL.md`
2. Ancestor walk from `cwd` (exclusive) toward the nearest `.git/` directory (or `userHome` if no git root is encountered): `<ancestor>/.chimera/skills/<name>/SKILL.md`
3. `<userHome>/.chimera/skills/<name>/SKILL.md`

When `includeClaudeCompat !== false`, the following tiers SHALL be searched after the Chimera tiers:

4. `<cwd>/.claude/skills/<name>/SKILL.md`
5. Ancestor walk for `.claude/skills/<name>/SKILL.md`
6. `<userHome>/.claude/skills/<name>/SKILL.md`

On name collision between tiers, the higher-priority tier SHALL win and the registry SHALL log a single warning line listing the losing path and the winning path.

#### Scenario: Project skill shadows home skill

- **WHEN** `.chimera/skills/pdf/SKILL.md` exists in the cwd AND `~/.chimera/skills/pdf/SKILL.md` exists
- **THEN** `registry.find("pdf").source` SHALL equal `"project"` and its `path` SHALL be the cwd copy; the user-home copy SHALL NOT appear in `registry.all()`

#### Scenario: Claude-compat opt-out

- **WHEN** `loadSkills({ ..., includeClaudeCompat: false })` is called and `.claude/skills/git/SKILL.md` is the only skill named `git`
- **THEN** `registry.find("git")` SHALL return `null`

### Requirement: System prompt index

`SkillRegistry.buildIndex()` SHALL return a string that begins with the literal line `# Available skills` and lists one entry per registered skill as:

```
- <name> — <description>
  path: <path>
```

The index SHALL NOT include SKILL.md body content. If the registry is empty, `buildIndex()` SHALL return the empty string (so `composeSystemPrompt` appends nothing).

The index SHALL be appended to the composed system prompt after any discovered `AGENTS.md` content but before any consumer-provided `systemPrompt` override.

#### Scenario: Empty registry contributes nothing to the system prompt

- **WHEN** a session starts with `--no-skills` or with no skills on disk
- **THEN** the system prompt SHALL NOT contain the literal `# Available skills` header

### Requirement: Activation tracking

At session start, the tools package SHALL receive the skill registry (via `ToolContext`) and SHALL maintain a set of absolute SKILL.md paths. After each `read` tool call completes successfully, if the resolved absolute path of the read target is in that set, the tools package SHALL emit a `skill_activated { skillName, source }` event on the session.

Activation tracking SHALL NOT change the behavior of the `read` tool; it is purely observational.

#### Scenario: Read of a SKILL.md fires activation

- **WHEN** the model calls `read { path: ".chimera/skills/pdf/SKILL.md" }` and the read succeeds
- **THEN** a `skill_activated { skillName: "pdf", source: "project" }` event SHALL appear on the session's event stream

#### Scenario: Read of a non-skill file

- **WHEN** the model calls `read { path: "src/index.ts" }`
- **THEN** no `skill_activated` event SHALL be emitted

### Requirement: CLI / SDK surface

`@chimera/cli` SHALL:

- Accept `--no-skills` (disable discovery + index + activation tracking for the session) and `--no-claude-compat` (skip tiers 4–6).
- Expose `chimera skills` listing the resolved registry as a table (columns: name, source, path, description); `--json` SHALL produce machine-readable output.
- Honor `skills.enabled` and `skills.claudeCompat` keys in `~/.chimera/config.json` as defaults overridable by flags.

`@chimera/server` SHALL expose `GET /v1/sessions/:id/skills` returning `Skill[]`.

`@chimera/client` SHALL implement `listSkills(sessionId)` wrapping that endpoint (the method is already typed in MVP).

#### Scenario: `chimera skills --json` output

- **WHEN** a user runs `chimera skills --json` in a project with two discovered skills
- **THEN** stdout SHALL contain a single JSON array of two objects each matching the `Skill` shape, and the process SHALL exit 0

#### Scenario: listSkills via SDK

- **WHEN** a consumer calls `await client.listSkills(sessionId)` against a running server
- **THEN** the returned array SHALL equal the server's `registry.all()` at the moment the session was created
