# Skills

Skills are model-invoked capabilities authored as Markdown files with YAML frontmatter. Chimera discovers them at session start and lists them in the system prompt; the model decides when to read a specific `SKILL.md` to act on its contents.

## Authoring a skill

Each skill lives in its own directory:

```
.chimera/skills/<name>/SKILL.md
```

`SKILL.md` begins with YAML frontmatter:

```markdown
---
name: pdf
description: Manipulate PDF files — use when the user asks to read, merge, or split PDFs.
---

# PDF skill

(instructions, examples, scripts the model should follow)
```

**Required fields**: `name` (must equal the directory name) and `description` (one sentence telling the model when to use the skill).

**Optional fields**: `version`, `license`. Any additional scalar fields are preserved on the registry entry.

Folded (`>` / `>-`) and literal (`|` / `|-`) block scalars are supported for multi-line descriptions.

## Discovery

Discovery tiers, highest-priority first:

1. `<cwd>/.chimera/skills/<name>/SKILL.md`
2. Ancestor walk from `<cwd>` up to the nearest `.git/` (or `$HOME`)
3. `~/.chimera/skills/<name>/SKILL.md`
4. `<cwd>/.claude/skills/<name>/SKILL.md`
5. Ancestor `.claude/skills/<name>/SKILL.md`
6. `~/.claude/skills/<name>/SKILL.md`

Name collisions resolve higher-tier-wins with a stderr warning naming both paths. `.claude/skills/` tiers exist for zero-friction compatibility with existing Claude Code authored skills.

## Runtime behaviour

- The composed system prompt includes a `# Available skills` block listing every resolved skill by name, description, and path. The body of each `SKILL.md` is NOT included; the model reads it via the `read` tool when it decides to activate.
- When the model calls `read` on a known `SKILL.md` path, Chimera emits a `skill_activated { skillName, source }` event. The TUI renders a `📚 skill: <name>` indicator under the triggering `read` row.
- Multiple reads of the same `SKILL.md` emit the event each time (intentional — simpler than per-session dedup, matches what consumers see).

## CLI

```sh
chimera skills                    # table of resolved skills
chimera skills --json             # machine-readable
chimera skills --no-claude-compat # skip the three .claude/skills tiers
chimera --no-skills               # disable discovery + injection for a session
chimera run --no-skills ...       # same, for one-shot runs
```

Config defaults live under `skills.enabled` and `skills.claudeCompat` in `~/.chimera/config.json`; CLI flags override.

## SDK

```ts
const skills = await client.listSkills(sessionId);
// → Skill[] as of session creation; re-create the session to pick up disk changes.
```

## Limitations (V1)

- No skill package manager (`chimera skill add …` is out of scope).
- Frontmatter parsing is YAML-subset: flat scalar keys plus `|` / `>` block scalars. Nested mappings and sequences are not interpreted.
- Invalid or malformed `SKILL.md` files are skipped with one warning line and do not prevent the session from starting.
