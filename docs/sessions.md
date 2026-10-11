# Sessions and files

Chimera saves each session to disk. You can resume a session, fork it, and
rewind it to an earlier message. This page also lists each file that Chimera
writes.

## Sessions in the TUI

The TUI has four session commands:

- `/new` — create a fresh root session and switch to it. The previous session is persisted and remains listable.
- `/sessions` — open an interactive picker (↑/↓ to navigate, Enter to switch, Esc to cancel). Sessions are shown as a tree, with forks indented under their parents.
  - `/sessions tree` prints a static tree to scrollback.
  - `/sessions <id>` prints details for one session: full id, cwd, model, parent, child count, and ancestry chain.
- `/fork [purpose]` — create a child session inheriting the current session's conversation state. The parent is unchanged. In `overlay` sandbox mode the parent's filesystem upperdir is snapshotted into a new upperdir for the child, so the child's filesystem changes do not affect the parent.
- `/rewind` — open an interactive picker showing every user message in the session with a summary of the tool calls that followed it. Enter rewinds in-place, truncating the event log and preloading the selected message into the input buffer. Shift+Enter forks from the checkpoint into a new child session, preserving the original branch. Escape cancels. In-place rewind is destructive (history after the checkpoint is removed); use Shift+Enter if you want to keep the original branch.

  In-place rewind also restores the **working tree**: before each user message
  runs, Chimera snapshots the session cwd into a shadow git repo
  (`~/.chimera/sessions/<id>/workspace.git` — your project's own `.git` is
  never touched, and the project `.gitignore` is respected). Rewinding checks
  out the snapshot taken just before the selected message, removing files the
  agent created after it. The pre-rewind tree is committed to the shadow repo
  first, so a rewind is itself recoverable with plain git commands against
  the shadow repo. The TUI reports whether the tree was restored or the
  rewind was conversation-only. Disable with `"workspaceCheckpoints": false`
  in `~/.chimera/config.json`.

## Resume from the command line

Resume across server restarts:

```
chimera resume <id>     # subcommand, by id
chimera resume          # subcommand, no id → stdin picker scoped to cwd
chimera continue        # subcommand: resume the most-recently-active session in cwd
chimera c               # subcommand alias of `continue`
chimera --resume <id>   # flag on the default interactive command
chimera --resume        # flag, no value → same stdin picker
chimera --continue      # flag on the default interactive command
chimera -c              # short flag alias of `--continue`
```

`chimera c` (subcommand) and `chimera -c` (flag on the default command) are
two different entry points but behave identically; same for `--continue` and
the `continue` subcommand. All resume/continue paths are scoped to the
working directory by default — you only see and continue sessions that were
started in the current `cwd`. Inside the TUI, `/sessions` is similarly
scoped; use `/sessions all` to see every session across all directories.

## Manage saved sessions

```
chimera sessions list              # sessions of the current directory
chimera sessions list --all        # every saved session
chimera sessions rm <id>           # delete a session (refused if the session has children)
chimera sessions review-bash <id>  # the bash commands of a session and their approval outcomes
```

`chimera sessions` with no subcommand lists the sessions of the current
directory. `review-bash` is described in
[Host bash command policy](bash-command-policy.md#decision-audit).

## Files on disk

All state of the user is under `~/.chimera/`. Project state is under
`<cwd>/.chimera/`.

In your home directory:

| Path | Contents |
| --- | --- |
| `~/.chimera/config.json` | The configuration, read at start. It also holds the MCP server definitions (`mcpServers`), not their tokens. |
| `~/.chimera/sessions/<id>/session.json` | Session metadata: ids, cwd, model, mode, usage, task list, goal, granted paths. Written with a temp file and a rename. |
| `~/.chimera/sessions/<id>/events.jsonl` | Append-only event log, one JSON object for each line. Only `step_finished`, `message_appended`, `permission_resolved`, `run_finished` and `forked_from` are saved. Text deltas and tool starts are not. |
| `~/.chimera/sessions/<id>/workspace.git` | Shadow git repository with the working tree snapshots that `/rewind` restores. |
| `~/.chimera/sessions/<id>.compactions.jsonl` | One line for each compaction of the session. |
| `~/.chimera/recall/<id>/` | Tool outputs that were archived. The `recall` tool reads them. |
| `~/.chimera/projects/<project-id>/memory/` | The project's memory. See [Project memory](context.md#project-memory). |
| `~/.chimera/permissions.json` | Permission rules that you remembered for all projects. |
| `~/.chimera/logs/<date>.log` | Activity log, one JSON object for each line. API keys are never written. |
| `~/.chimera/logs/permission-decisions.jsonl` | The audit of approval decisions. It can contain full commands. |
| `~/.chimera/instances/<pid>.json` | One lockfile for each running instance. Removed at exit, and by `chimera ls` when the instance does not answer. |
| `~/.chimera/mcp-auth/` | MCP OAuth registrations and credentials, readable by the owner only. |
| `~/.chimera/overlays/<id>/` | The pending changes of a Docker sandbox in `overlay` mode. |
| `~/.chimera/theme.json`, `~/.chimera/themes/` | The active theme and your own presets. |
| `~/.chimera/hooks/`, `skills/`, `commands/`, `agents/`, `modes/` | Your hooks, skills, commands, agent definitions and modes for all projects. |

In a project:

| Path | Contents |
| --- | --- |
| `<cwd>/.chimera/permissions.json` | Permission rules that you remembered for the project. |
| `<cwd>/.chimera/hooks/`, `skills/`, `commands/`, `agents/`, `modes/` | The same as in your home directory, for this project only. |

With the OS sandbox active, Chimera creates `<cwd>/.chimera/` if it does not
exist. See [Sandboxes](sandbox.md).

> **Breaking change**: prior versions wrote sessions as flat `~/.chimera/sessions/<sessionId>.json` files. Those files are ignored by the current version — they are not migrated and not listed. To recover their contents, open the file directly.

> **Concurrent access**: there is no inter-process locking on a session. If two clients hold the same session id, writes are last-write-wins for `session.json` and atomic-per-line for `events.jsonl` appends. Practically: don't open the same session twice.

See [the gitignore template](gitignore-template.md) for recommended `.gitignore` entries.
