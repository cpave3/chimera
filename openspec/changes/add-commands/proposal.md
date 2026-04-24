## Why

`spec.md` §10 defines commands as user-invoked prompt templates: markdown files with YAML frontmatter, discovered on the same path tiers as skills, and expanded client-side when the user types `/<name> args` in the TUI or passes `--command <name>` to `chimera run`. MVP ships built-in slash commands (`/help`, `/clear`, etc.) but routes every other `/...` input to an "unknown command" hint. This change fills in the user-template registry so projects can ship `.chimera/commands/review.md` et al.

## What Changes

- Introduce `@chimera/commands` with `loadCommands({ cwd, userHome, includeClaudeCompat })` returning a `CommandRegistry`.
- Implement the same six-tier discovery chain as skills (Chimera cwd / ancestors / home, then `.claude/` compat) with identical collision resolution.
- Parse YAML frontmatter (optional `description`; the body is the prompt template).
- Implement placeholder expansion per `spec.md` §10.2: `$ARGUMENTS`, `$1`, `$2`, ..., `$CWD`, `$DATE`. Unknown placeholders are left as-is so shell vars like `$PATH` survive.
- Change TUI slash-command dispatch: unknown `/<name>` is no longer an error — the TUI consults the registry, expands the template, and sends the result as a normal user message. Only when no command matches does the "did you mean…" fuzzy-match hint fire.
- Implement `chimera run --command <name> --args "..."`: load the registry, expand, run one-shot with the expanded prompt as the first user message.
- Implement `chimera commands` subcommand listing the registry.
- Add server endpoint `GET /v1/sessions/:id/commands` and SDK method `listCommands(sessionId)` (typed in MVP); expansion stays client-side.

## Capabilities

### New Capabilities

- `commands`: discovery, frontmatter parsing, placeholder expansion, CLI/TUI/SDK dispatch surfaces.

### Modified Capabilities

None. MVP's `tui` spec explicitly predicts this delta ("user-template slash commands are explicitly deferred to a later change"). The new TUI dispatch behavior is captured inside the `commands` ADDED requirements rather than as a formal MODIFIED delta — when this change applies cleanly after `chimera-mvp`, the TUI implementation is updated to honor the `commands` spec's "TUI dispatch" requirement. A later cleanup change can fold this into a true MODIFIED delta on the `tui` spec once the archived spec structure settles.

## Impact

- **Prerequisites**: `chimera-mvp` applied and archived.
- **Code changes outside the new package**:
  - `@chimera/tui`: consult the commands registry before showing the "unknown command" hint; expand template and send as user message.
  - `@chimera/cli`: register `chimera commands`; wire `--command <name> --args "..."` into `chimera run`.
  - `@chimera/server`: expose `GET /v1/sessions/:id/commands` (commands are loaded server-side at session start for introspection; expansion happens client-side so the server never sees template bodies during a run).
  - `@chimera/client`: implement `listCommands(sessionId)`.
- **Filesystem**: reads from the same six tiers as skills, `.chimera/commands/` and `.claude/commands/`. Writes nothing.
- **Built-ins stay built-in**: the existing TUI built-in list (`/help`, `/clear`, `/new`, `/sessions`, `/exit`, `/model`, `/rules`) is never overridden by a user template of the same name. Registration order: built-ins first, templates second, collisions logged.
