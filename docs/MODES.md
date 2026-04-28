# Modes

A **mode** controls what the agent can see (its system-prompt fragment) and
what it can do (its tool allowlist) for a given turn. Modes are file-based,
just like skills and commands; you ship one as a markdown file under
`.chimera/modes/<name>.md` (or any of the other discovery tiers below) and
Chimera picks it up.

## Default modes

Chimera ships with two built-ins:

- **`build`** — the default. No tool allowlist (every registered tool is
  available); minimal prompt fragment. New sessions start in `build` unless
  you pass `--mode <name>` or set `defaultMode` in config.
- **`plan`** — read-only. `tools: [read]`; the body steers the model toward
  building context, producing a numbered plan, surfacing assumptions, and
  ending with `Plan ready for review.` rather than mutating anything.

You can override either by dropping your own `build.md` / `plan.md` into a
higher-priority discovery tier.

## Authoring a mode

A mode is a single markdown file with YAML frontmatter:

```markdown
---
name: question
description: Read-only Q&A about the codebase.
tools: [read]
color: "#7ed957"
---

You are operating in question mode. Use the `read` tool freely to browse the
repository. Answer the user's question with file:line citations; do not
produce implementation plans.
```

Frontmatter fields:

| field         | required | meaning                                                                                                    |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | Must match the filename stem.                                                                              |
| `description` | yes      | One-sentence description. Shown in `/mode` listings.                                                       |
| `tools`       | no       | Tool-name allowlist. Omitted = all tools. `[]` = no tools (pure text). Listed = exactly those.             |
| `model`       | no       | `providerId/modelId` reference. A soft default; `userModelOverride` (CLI `-m`, `/model`) always wins.      |
| `color`       | no       | `#rgb` or `#rrggbb` for the TUI status-bar widget. Absent = derived deterministically from `name`.         |
| `cycle`       | no       | When `false`, excluded from `Shift+Tab` cycling. Default `true`. Mode remains selectable via `/mode`.   |

The body (everything after the closing `---`) is appended verbatim to the
system prompt under a `# Current mode: <name>` header whenever the mode is
active.

## Discovery

`loadModes` walks six tiers in priority order (higher tiers win on name
collision; collisions emit one warning each), then a seventh tier for the
package's bundled built-ins:

1. `<cwd>/.chimera/modes/<name>.md`
2. `<ancestor>/.chimera/modes/<name>.md` (walking up to the nearest `.git/`)
3. `<userHome>/.chimera/modes/<name>.md`
4. `<cwd>/.claude/modes/<name>.md` (unless `--no-claude-compat`)
5. `<ancestor>/.claude/modes/<name>.md`
6. `<userHome>/.claude/modes/<name>.md`
7. `@chimera/modes/builtin/<name>.md` (bundled defaults)

So your `~/.chimera/modes/question.md` is visible in every session, your
project's `<repo>/.chimera/modes/<name>.md` is visible only in that repo
(and shadows the user/builtin equivalents), and the bundled `build.md` /
`plan.md` come along for free.

## Switching modes

- **CLI**: `chimera --mode plan` or `chimera run --mode plan ...` sets the
  initial mode for the new session.
- **Config**: `defaultMode: "<name>"` in `~/.chimera/config.json` (or
  `<project>/.chimera/config.json` once project config lands). `--mode`
  overrides.
- **TUI built-in**: `/mode` lists modes; `/mode <name>` queues a switch.
- **TUI keybind**: `Shift+Tab` cycles forward through `cycleModes`. When
  `cycleModes` isn't set in config, the cycle defaults to *every discovered
  mode* (alphabetical), so a user `question.md` gets picked up automatically.
  Set `cycleModes: ["build", "plan"]` explicitly to restrict the keybind.
- **HTTP / SDK**: `POST /v1/sessions/:id/mode { "mode": "plan" }` queues a
  switch; `client.setMode(sessionId, name)` wraps it. `GET
  /v1/sessions/:id/modes` returns the bound registry.

In-session switches are queued — they're applied at the top of the next
run rather than mid-step. When you `/mode plan` while a run is active, the
TUI also issues `interrupt()` so the active run terminates promptly and
your next message lands in plan mode immediately.

## Color

Each `Mode.colorHex` is resolved at load time:

1. If frontmatter `color:` is a valid CSS hex (`#rgb` or `#rrggbb`),
   normalize it to `#rrggbb` lowercase and use it.
2. Otherwise, derive deterministically: FNV-1a hash of `name` → hue, fixed
   `s=65%`, `l=55%`, then HSL→RGB. Same name → same color, every time.
3. If `color:` is set but doesn't parse, warn once and fall back to the
   derived value.

The TUI status bar tints the bracketed mode name with `colorHex`; while a
switch is queued, both the current and queued names are tinted with their
own colors:

```
[mode:build]                  ← idle in build
[mode:build → plan]           ← /mode plan queued; build still active
[mode:plan]                   ← switch landed
```

## `Session.mode` and `Session.userModelOverride`

These two fields are persisted in the session snapshot:

- `mode: string` — defaults to `"build"`. Survives resume.
- `userModelOverride: string | null` — defaults to `null`. Set by `-m` /
  `/model <ref>`. Sticky across mode switches.

Effective model per call resolves as:

```
userModelOverride ?? currentMode.model ?? config.defaultModel
```

So a user who said "use opus" via `-m` keeps opus across `/mode plan`,
even if `plan.md` declares `model: anthropic/haiku`.
