# User commands

Commands are user-authored prompt templates invoked as `/<name>` in the TUI or
via `chimera run --command <name>`. They are pure text substitution: given some
arguments, the template body is expanded and sent to the model as a normal
user message. The server never sees the template body during a run — expansion
happens entirely on the client.

## Authoring a command

Create a markdown file at `<name>.md` in any of the tiers listed below. The
file name (without `.md`) becomes the invocation name.

```md
---
description: Review the current diff for regressions
---
Review the changes in $ARGUMENTS. Focus on correctness and test coverage.
Surface anything that would surprise a reader.
```

The YAML frontmatter is optional. `description` is the only field Chimera
currently reads; other keys are preserved but not interpreted. Omit the
frontmatter entirely for a body-only template:

```md
Write a cheerful greeting.
```

The body is stored verbatim — leading/trailing whitespace and blank lines are
preserved.

## Discovery tiers

`loadCommands` searches these directories, in priority order (first match
wins, with one warning logged per shadowed duplicate):

1. `<cwd>/.chimera/commands/<name>.md`
2. `<ancestor>/.chimera/commands/<name>.md` — walk up to the nearest `.git/`
3. `<userHome>/.chimera/commands/<name>.md`
4. `<cwd>/.claude/commands/<name>.md`
5. `<ancestor>/.claude/commands/<name>.md`
6. `<userHome>/.claude/commands/<name>.md`

Claude-compat tiers (4–6) are included by default. Skip them with
`--no-claude-compat` on the CLI, or by setting `commands.claudeCompat: false`
in `~/.chimera/config.json`. Disable the whole system with
`commands.enabled: false`.

## Placeholder grammar

Exactly these placeholders are substituted; anything else (including shell
variables like `$PATH`) is left intact:

| Placeholder  | Meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| `$ARGUMENTS` | The entire raw args string passed at invocation time.        |
| `$1`..`$9`   | Positional args from a whitespace split that respects quotes. Missing positionals expand to the empty string. |
| `$CWD`       | The session's current working directory (absolute path).     |
| `$DATE`      | Today's date, `YYYY-MM-DD`, local timezone.                  |

Quoted args group into one positional: with `"auth module" urgent`,
`$1` is `auth module` and `$2` is `urgent`.

### Example

Template `.chimera/commands/review.md`:

```md
---
description: Review a module at a given priority
---
Review the $1 module (priority: $2). Cwd: $CWD. Date: $DATE.
```

Invocation:

```sh
chimera run --command review --args '"auth module" urgent'
```

Expands to:

```
Review the auth module (priority: urgent). Cwd: /home/me/proj. Date: 2026-04-24.
```

## Precedence and collisions

Built-in slash commands (`/help`, `/clear`, `/new`, `/sessions`, `/exit`,
`/model`, `/rules`) always win over a user template of the same name. A
warning is logged once at session start; the template is never expanded.

Across tiers, higher-priority tiers win and the shadowed duplicate is logged.

## Dispatch surfaces

- **TUI**: typing `/foo bar baz` resolves to built-in → user template → fuzzy
  hint. When a user template matches, the expanded body is sent as a normal
  user message.
- **CLI one-shot**: `chimera run --command foo --args "bar baz"` loads the
  registry, expands, and runs with the result as the first user message.
  `--command` is mutually exclusive with a positional prompt.
- **Introspection**: `chimera commands` lists registered commands (add
  `--json` for a machine-readable dump). The server exposes the same data
  via `GET /v1/sessions/:id/commands`; SDK users can call
  `client.listCommands(sessionId)`. The server loads commands once at
  session start — changes on disk do not take effect until a new session is
  created.

## Hot reload in the TUI

The interactive TUI watches the tier directories that existed at startup and
re-reads commands whenever a `.md` file in one of them changes (created,
modified, deleted). On reload the scrollback prints
`commands reloaded (N total)`, and `/help` and `/your-new-command` pick up the
new state immediately.

Use `/reload` to force a re-read — needed when the change is in a tier
directory that didn't exist when the TUI started (e.g. you just created
`.chimera/commands/` for the first time), or on filesystems where `fs.watch`
is unreliable.

Hot reload is TUI-only. The server's `GET /v1/sessions/:id/commands` still
serves the snapshot captured at session creation; headless consumers should
start a new session to pick up changes.
