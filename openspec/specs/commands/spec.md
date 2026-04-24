# commands Specification

## Purpose

The `commands` capability defines user-authored slash commands for Chimera: Markdown files with optional YAML frontmatter whose bodies serve as prompt templates. It specifies the on-disk file format, the discovery tier order (including Claude Code compatibility paths), client-side placeholder expansion, how the TUI dispatches slash input across built-ins and templates, the CLI surface for listing and one-shot invocation, and the server/SDK surface for enumerating a session's commands.

## Requirements

### Requirement: Command file format

A command is a file `<root>/<name>.md` where `<name>` is its invocation name (`/<name>` in the TUI). The file SHALL begin with optional YAML frontmatter delimited by `---` lines. Frontmatter MAY contain a `description` field; other fields are preserved but not interpreted. The body after the frontmatter is the prompt template.

#### Scenario: Command with frontmatter

- **WHEN** `.chimera/commands/review.md` begins with `---\ndescription: Review the current diff\n---\n` followed by template text
- **THEN** `loadCommands().find("review")` SHALL return `{ name: "review", description: "Review the current diff", body: <template>, path: <absolute>, source: "project" }`

#### Scenario: Command without frontmatter

- **WHEN** `.chimera/commands/say-hi.md` contains only `Hello!` with no `---` fence
- **THEN** `find("say-hi").body` SHALL equal `"Hello!"` and `description` SHALL be `undefined`

### Requirement: Discovery paths

`loadCommands({ cwd, userHome, includeClaudeCompat })` SHALL search tiers in this priority order:

1. `<cwd>/.chimera/commands/<name>.md`
2. Ancestor walk from `cwd` toward the nearest `.git/` (or `userHome` if no git root): `<ancestor>/.chimera/commands/<name>.md`
3. `<userHome>/.chimera/commands/<name>.md`

When `includeClaudeCompat !== false`:

4. `<cwd>/.claude/commands/<name>.md`
5. Ancestor walk for `.claude/commands/<name>.md`
6. `<userHome>/.claude/commands/<name>.md`

Name collisions SHALL resolve higher-tier-wins with one log warning per collision.

#### Scenario: Project command shadows Claude-compat

- **WHEN** `.chimera/commands/review.md` and `.claude/commands/review.md` both exist in cwd
- **THEN** `find("review").source` SHALL equal `"project"` and its `path` SHALL be the Chimera-path copy

### Requirement: Placeholder expansion

`CommandRegistry.expand(name, args)` SHALL substitute placeholders in the template body using these rules (applied in order):

1. `$ARGUMENTS` → the entire raw `args` string.
2. `$1` through `$9` → positional arguments from a whitespace split of `args` that respects balanced double-quotes (so `"a b" c` yields `$1 = "a b"`, `$2 = "c"`). Missing positionals expand to the empty string.
3. `$CWD` → the session's current working directory, absolute path.
4. `$DATE` → the current date in ISO `YYYY-MM-DD` form, local timezone.

Any `$`-prefixed token not listed above SHALL be left literally in the output.

The result SHALL be a string that the consumer uses as a user message. `expand()` SHALL NOT make any network call, invoke the model, or touch the server.

#### Scenario: Positional with quoted argument

- **WHEN** `expand("review", '"auth module" urgent')` is called on a template containing `Review: $1 (priority: $2)`
- **THEN** the returned string SHALL contain `Review: auth module (priority: urgent)`

#### Scenario: `$PATH` survives

- **WHEN** a template body contains a shell snippet with literal `$PATH`
- **THEN** `expand` SHALL leave `$PATH` unchanged in the output

#### Scenario: Unknown command

- **WHEN** `expand("nope", "")` is called and no command named `nope` is in the registry
- **THEN** the method SHALL throw an Error naming the missing command

### Requirement: TUI dispatch of slash input

When a user submits input beginning with `/` in the TUI, the TUI SHALL resolve it in three tiers: built-in, user template, then fuzzy-match fallback. Specifically:

1. The TUI SHALL first consult its hardcoded built-in list (`/help`, `/clear`, `/new`, `/sessions`, `/exit`, `/model`, `/rules`, plus any built-ins added by other changes). On a match, the built-in SHALL handle the input without involving the commands registry.
2. Otherwise, the TUI SHALL consult the loaded commands registry. On a match, it SHALL call `registry.expand(name, args)` and send the expanded string as a normal user message to the current session.
3. Otherwise, the TUI SHALL render an inline hint `unknown command: /<name> — did you mean /<best-match>?` using a fuzzy match against the union of built-in and template names. The input SHALL NOT be sent to the model.

Built-in names SHALL shadow template names with the same name, and a single log warning SHALL be emitted at session start per such collision.

#### Scenario: User template handles previously-unknown slash

- **WHEN** `.chimera/commands/summarize.md` exists with body `Summarize $ARGUMENTS` and the user types `/summarize the current branch`
- **THEN** the TUI SHALL send the user message `"Summarize the current branch"` to the session (no "unknown command" hint)

#### Scenario: Built-in still wins over template

- **WHEN** `.chimera/commands/help.md` exists and the user types `/help`
- **THEN** the built-in `/help` SHALL render; `help.md` SHALL NOT be expanded, and one warning SHALL have been logged at session start

### Requirement: CLI surface

`@chimera/cli` SHALL:

- Accept `chimera run --command <name> --args "..."` which loads the registry, calls `expand`, and runs one-shot with the expanded string as the first user message.
- Expose `chimera commands` listing registered commands tabularly; `--json` SHALL produce machine-readable output.
- Accept `--no-claude-compat` (shared with `add-skills`) to skip tiers 4–6.
- Honor `commands.enabled` and `commands.claudeCompat` in `~/.chimera/config.json`.

Passing `--command` together with a positional prompt SHALL exit non-zero with an error; they are mutually exclusive.

#### Scenario: `chimera run --command`

- **WHEN** a user runs `chimera run --command review --args "auth module"` with a template body `Review the auth module: $ARGUMENTS`
- **THEN** the first user message sent to the model SHALL equal `"Review the auth module: auth module"`

### Requirement: Server / SDK surface

`@chimera/server` SHALL expose `GET /v1/sessions/:id/commands` returning `Command[]` based on the session's bound registry. `@chimera/client` SHALL implement `listCommands(sessionId)` wrapping that endpoint.

The server SHALL NOT expose a `/commands/expand` endpoint — expansion is always client-side.

#### Scenario: listCommands reflects server state

- **WHEN** a consumer calls `await client.listCommands(sessionId)` after two commands were discovered at session start
- **THEN** the returned array SHALL contain exactly those two entries, and a later addition of a file on disk SHALL NOT appear until a new session is created
