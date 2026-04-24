## 1. Package scaffolding

- [ ] 1.1 Add `packages/commands/` to the workspace. Dependencies: `@chimera/core` types, a minimal YAML parser (reuse the one pulled in by `add-skills` if landed).
- [ ] 1.2 Define `Command`, `CommandRegistry` types and stub `loadCommands`.

## 2. Discovery

- [ ] 2.1 Factor the six-tier path walker out of `@chimera/skills` (or duplicate it minimally) so both packages share one implementation.
- [ ] 2.2 Scan each tier for `*.md` files; derive `name` from the filename (sans `.md`).
- [ ] 2.3 Implement collision resolution and warning logs.

## 3. Frontmatter + body parsing

- [ ] 3.1 Parse optional `---`-delimited YAML header; treat a missing header as `description: undefined`.
- [ ] 3.2 Store the body verbatim (no trimming of meaningful whitespace).

## 4. Expansion

- [ ] 4.1 Implement a small `splitArgs(s)` helper respecting balanced double-quotes.
- [ ] 4.2 Implement `expand(name, args)` substituting `$ARGUMENTS`, `$1`..`$9`, `$CWD`, `$DATE`; leave other `$`-tokens intact.
- [ ] 4.3 Unit tests: `$PATH` survives, `$1` with quoted args, missing positional → empty string, unknown command throws.

## 5. TUI integration

- [ ] 5.1 Rewrite the slash-dispatch code path to: built-ins → registry → fuzzy hint.
- [ ] 5.2 Update `/help` to also list user commands with their descriptions.
- [ ] 5.3 Log built-in↔template name collisions at TUI startup.
- [ ] 5.4 Snapshot tests: built-in precedence, template dispatch, unknown-command hint.

## 6. CLI

- [ ] 6.1 Parse `--command <name>` and `--args "..."` on `chimera run`; make them mutually exclusive with the positional prompt.
- [ ] 6.2 Wire expansion: load registry, call `expand`, run with the result as the first user message.
- [ ] 6.3 Implement `chimera commands` (tabular + `--json`).
- [ ] 6.4 Honor `commands.enabled` / `commands.claudeCompat` config keys.

## 7. Server / Client

- [ ] 7.1 Implement `GET /v1/sessions/:id/commands`.
- [ ] 7.2 Implement `client.listCommands(sessionId)`.

## 8. Documentation / E2E

- [ ] 8.1 Write `COMMANDS.md`: authoring a `.md` template, placeholder grammar, examples.
- [ ] 8.2 E2E: project with `.chimera/commands/summarize.md` → `chimera run --command summarize --args "foo"` runs with expanded prompt.
- [ ] 8.3 E2E: TUI typing `/summarize bar` dispatches to the template.
- [ ] 8.4 E2E: built-in-vs-template collision logs a warning and built-in wins.
- [ ] 8.5 E2E: `--no-claude-compat` hides `.claude/commands/*` entries.
