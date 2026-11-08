# The TUI

The interactive `chimera` command opens the TUI. This page describes the
screen, the keys, the commands, the prompt, notifications and themes.

## Keys

`?` at an empty prompt shows this list in the TUI.

| Key | Action |
| --- | --- |
| `Enter` | Send. During a run: steer the agent. |
| `Tab` | During a run: hold the message for the next turn. |
| `Shift+Enter` | New line where the terminal reports it; `Alt+Enter`, or `\` then `Enter`, everywhere. |
| `Ctrl+G` | Edit the prompt in `$EDITOR`. |
| `Ctrl+V` | Paste an image from the clipboard. |
| `Ctrl+T` | Open the full transcript in a pager. |
| `Ctrl+O` | Expand or collapse every tool output and thought. |
| `Up` / `Down` | Prompt history. |
| `Shift+Tab` | Cycle the mode. |
| `/` | Commands; `Tab` completes. |
| `@path`, `#path` | Attach a file to read, or a file to write. |
| `!command` | Run a shell command yourself. The output goes into the conversation. |
| `Esc` | Interrupt the run. |
| `Ctrl+C` | Interrupt; press it twice to exit. |
| `Ctrl+Z` | Suspend. |
| `PgUp` / `PgDn`, mouse wheel | Scroll the transcript (fullscreen), or a card too tall for the screen. |
| `Ctrl+Home` / `Ctrl+End` | Jump to the top of the transcript, and back to the newest output (fullscreen). |

A `!command` runs in your shell with your rights. It does not go through the
approval rules or the sandbox, because you typed it.

## Commands

| Command | Action |
| --- | --- |
| `/help` | List the commands. |
| `/new` | Create a session and switch to it. |
| `/sessions` | Pick a session of this directory (`/sessions all`, `/sessions tree`, `/sessions <id>`). |
| `/fork [purpose]` | Fork the session into a child. |
| `/rewind` | Go back to an earlier message; restores the working tree too. |
| `/model [ref]` | Show or change the model. |
| `/mode [name]` | Show the modes or switch. |
| `/goal [condition \| clear]` | Show, set or clear the session's goal. |
| `/rules` | List the permission rules (`/rules rm <n>` deletes one). |
| `/add-read-path <path>`, `/add-write-path <path>` | Grant access to a file or directory outside the project. The rest of the line is the path, spaces included; quotes are optional. |
| `/context` | Show a token breakdown of the context. |
| `/compact` | Compact the context now. |
| `/reload` | Read commands and instruction files again. |
| `/memory` | Edit the project's memory index in `$EDITOR`. |
| `/theme [name]` | List or apply a colour theme. |
| `/subagents`, `/attach <id>`, `/detach` | List subagents; view one; go back to the parent. |
| `/overlay`, `/apply`, `/discard` | Review the pending changes of a Docker `overlay` sandbox. |
| `/clear` | Clear the transcript on screen. |
| `/exit` | Exit. |

Your own commands and skills appear in the same menu. See
[User commands](COMMANDS.md) and [Skills](../SKILLS.md). Sessions are
described in [Sessions and files](sessions.md), goals in [Goals](goals.md),
and modes in [Modes](MODES.md).

## The screen

The TUI has two layouts that look the same. **Fullscreen** is the default:
it takes the terminal's alternate screen and scrolls the transcript itself.
**Inline** prints into the terminal's own scrollback and repaints only the
rows that changed; use it on a slow link (for example SSH with high latency) or
when you want the session to stay in your scrollback.

```
chimera              # fullscreen
chimera --inline     # inline, for this invocation
```

```json
{ "tui": { "layout": "inline", "mouse": true } }
```

`tui.layout` in `~/.chimera/config.json` sets the default (`fullscreen` or
`inline`); the flag wins. Without a TTY on stdout, or with `TERM=dumb`,
Chimera uses the inline layout whatever is set. `resume`, `continue` and
`attach` take `--inline` too.

### Fullscreen layout

The transcript fills the screen; the prompt box and the status line stay
pinned to the bottom.

```
chimera  v0.4.0 · manticore/gpt-5 · ~/Projects/yggdrasil
         60 skills · 9 commands

    you  add a --json flag to `yg list` and cover it with a test
  think  The list command lives in src/yg/commands/list.ts. Other commands…
   read  src/yg/commands/list.ts  120 lines
   grep  "json" in src/yg  4 matches

         `status` already prints JSON through `printJson`, so `list` can reuse it.
   edit  src/yg/commands/list.ts  +2 −1
           43   export function list(opts: ListOptions) {
           44 - const trees = readWorktrees();
           44 + const trees = readWorktrees(opts.root);
 ✗ bash  pnpm vitest run yg/list  exit 1 · 4.2s
         FAIL  test/list.test.ts > list > prints a table
         AssertionError: snapshot mismatch
         - Snapshot  -1
         … 5 more · ctrl+o
⠋ write  src/yg/commands/list.test.ts  writing…
  tasks  2/4 ✓ ✓ ▸ snapshot test for the JSON shape ○
╭─ build ─────────────────────────────── ⠋ 12s · esc interrupt · tab queue ─╮
│ ›                                                                          │
╰─ manticore/gpt-5 · 38%/200k ────────────── ~/Projects/yggdrasil · main ↑1 ─╯
   8AWWBRGC · os sandbox
```

- **Following.** The transcript follows the newest output. `PgUp`, `PgDn` and
  the mouse wheel scroll it; while you are scrolled away, new output does not
  move what you read. `Ctrl+Home` jumps to the top; `Ctrl+End`, or sending a
  message, follows the newest output again.
- **Mouse.** The wheel scrolls the transcript, or a card too tall for the
  screen. Set `tui.mouse` to `false` to leave the mouse to the terminal.
- **Handing over.** `Ctrl+G` (your editor), `Ctrl+T` (the pager) and `Ctrl+Z`
  (suspend) give the terminal back to the program or the shell, and the TUI
  redraws everything when it gets it back.
- **Exit.** The alternate screen takes the session with it, so Chimera prints
  the session id and the `chimera --session <id>` command that resumes it.
  `Ctrl+T` opens the full transcript in a pager at any time.

### Inline layout

```
› add retry logic to the provider client

◆ I will add backoff to the stream call. Then I will add a test.

● read 3 files · 1 search
  src/agent.ts (2409 lines), src/events.ts (217 lines), retry (4 matches), …
● edit packages/core/src/agent.ts (1 replacement)
  ╭──────────────────────────────────────────────────────────────────────────╮
  │ 1481 -           const stream = streamText({                             │
  │ 1481 +           const stream = this.startStep({                         │
  ╰──────────────────────────────────────────────────────────────────────────╯
✗ bash pnpm --filter @chimera/core test (exit 1) · 8.2s

─── 1m 12s · 6 steps · 7 tool calls · ↑ 114k ↓ 3.7k tokens · cache 78%

tasks 2/4
◼ Add a test for mid-stream errors
◻ Update README
⠹ running pnpm --filter @chimera/core test · 12s · step 3 · 3.1k tokens · esc to interrupt
────────────────────────────────────────────────────────────────────────────────
> _
build · anthropic/claude-opus-4-7 · sandbox os    ▰▰▰▰▱▱▱▱▱▱ 42% · 84k/200k · cache 81%
~/Projects/chimera · session 12345678 · tasks 2/4 · ◼ Add a test…      enter steer
```

- **Task panel.** During a run the task list shows above the prompt, from the
  task in progress onward, at most six lines.
- **Footer.** Row 1: mode, model and sandbox on the left; a context gauge with
  percentage, used/window tokens and the cached share of the last prompt on
  the right. Row 2: working directory, session id, task count and the task in
  progress on the left; the keys that matter in the current state on the
  right. On a narrow terminal each row drops its least important items first.
- **Start banner.** Version, model, working directory, session, mode, sandbox,
  and the number of skills and commands loaded.

### In both layouts

- **Label column.** Each entry is named in a right-aligned column: `you` for
  your messages, `think` for the model's reasoning (one dim line; `Ctrl+O`
  shows all of it), and the tool's name for a tool call. The assistant's text
  has no label.
- **Tool rows.** A call is one row, `label  argument  facts`: line counts,
  matches, the exit code of a failed command, how long it took. A running
  call has a spinner in its label, a failed one `✗` and its facts in the
  error colour. Output is cut to three rows plus `… N more · ctrl+o`; an edit
  shows `+N −M` and its numbered diff rows. Reads and searches that follow
  each other stack without blank lines. When a Docker sandbox is active the
  row also says `[host]` or `[sandbox]`.
- **Notices.** Errors, goal results, background agents, compactions, mode
  changes and the run summary are rows of their own (`✗ error`, `goal`,
  `agent`, `compact`, `mode`, `done`, `note`), wrapped between words.
- **Task row.** During a run the task list is one row above the prompt box:
  `tasks  2/4 ✓ ✓ ▸ task in progress ○`.
- **Prompt box.** Its top border shows the mode, and on the right the spinner,
  elapsed time and the keys that matter during a run, or `? help` when idle.
  Its bottom border holds the [status line](#status-line).
- **Cards.** Permission requests, questions, the sudo password, pickers, the
  slash and file menus and the key list (`?` at an empty prompt) are cards
  above the prompt box. While a card waits for your answer, the prompt box
  says so.
- **Approvals.** A permission request card lists the command, why it needs
  approval and what the reviewer or System One found, then the choices, one
  per row. Press a choice's key, or `↑`/`↓` and `Enter`; `Esc` denies.
  Feedback, patterns and prefixes are typed in a row inside the card. A
  request too tall for the screen scrolls inside the card (`PgUp`, `PgDn`,
  the wheel), and the choices stay in view. For an OS sandbox bypass, choose
  **Allow once**, **Allow exact command…**, or **Allow command prefix…**,
  then the session, project or global scope. See
  [OS sandbox](sandbox.md#os-sandbox) for the limits.
- **Reviewer and System One marks.** A tool row that the approval reviewer or
  the System One check allowed ends with `approved by reviewer` or
  `approved by System One`. See
  [Host bash command policy](bash-command-policy.md#approval-reviewer).
- **Full transcript.** `Ctrl+T` opens the whole session in a pager (`$PAGER`,
  else `less`): every tool call on its own line, with its full output.

Each built-in tool ships with a `formatScrollback` hook in its definition
that produces an args-only summary at call start and a result-aware summary
once the tool returns. Plugin tools authored via `defineTool` from
`@chimera/tools` opt in by passing `formatScrollback`; tools without one
fall back to a `<name> <truncated-JSON>` rendering.

## Status line

The status line sits in the prompt box's bottom border, with any further
rows dim under the box. By default it shows the model and the context used
on the left, the working directory and the git branch on the right, and the
session id and the sandbox in a row under the box:

```
╰─ anthropic/claude-sonnet · 38%/200k ──────── ~/Projects/app · main ↑2 ─╯
   8AWWBRGC · os sandbox
```

The context figure turns the warning colour above 70% and the error colour
above 90%.

Set your own rows in `~/.chimera/config.json`. Each row has a `left` and a
`right` list of built-in items; the first row goes in the border:

```json
{
  "statusLine": {
    "rows": [
      { "left": ["model", "context"], "right": ["cwd", "branch"] },
      { "left": ["session", "sandbox"] }
    ]
  }
}
```

| Item | Shows |
| --- | --- |
| `model` | the model, and the vision model a turn with images is routed to |
| `context` | context used, as a share of the window: `38%/200k` |
| `tokens` | session tokens in and out: `↑76k ↓3.7k` |
| `cost` | the session's cost, when the provider reports prices |
| `cache` | the share of the last prompt served from the provider's cache |
| `cwd` | the working directory |
| `branch` | the git branch, with commits ahead `↑` and behind `↓` |
| `session` | the session id |
| `sandbox` | the sandbox commands run in |
| `goal` | the session's goal |
| `update` | the updater's notice |

An item with nothing to say is left out. When a row does not fit, items
drop from the end of its lists: the right list first, then whichever list
has more.

### A status line command

To draw the status line with a script instead (ccstatusline and other
Claude Code status line scripts work), set `command`:

```json
{ "statusLine": { "command": "npx ccstatusline" } }
```

The command runs with `sh -c` in the working directory, with `COLUMNS` set
to the terminal width. On stdin it gets Claude Code's statusLine JSON where
Chimera has the same fact (`session_id`, `cwd`, `model`, `workspace`,
`version`, `output_style`, `cost`, `context_window`), and Chimera's own facts
under `chimera` (`mode`, `sandbox`, `branch`, `goal`, `context_percent`,
...). Its first output line goes in the border and the others under the box.

It runs again on session events, 300 ms after the last one; a new event
cancels a run still going, and a run is killed after 2 seconds. When a run
fails or is killed, the last good output stays.

## Multi-line prompt composition

The TUI prompt is multi-line. Three triggers insert a newline at the cursor
without submitting:

- **`\<Enter>`** — type a backslash, then press Enter. The trailing `\` is
  consumed and replaced with a newline. This works on every terminal and is
  the documented portable form.
- **`Shift+Enter`** / **`Alt+Enter`** — best-effort. Works wherever the
  terminal emits a distinguishable byte sequence (kitty keyboard protocol,
  iTerm2, modern xterm with `modifyOtherKeys`). On terminals that don't, the
  keystroke is reported as plain Enter and submits — fall back to
  `\<Enter>`.

For longer drafts, **`Ctrl+G`** opens `$VISUAL` / `$EDITOR` (falling back to
`vi`) on the current buffer. On save and clean exit the buffer is replaced
with the file's contents; non-zero exits leave the buffer alone and write a
single info line to scrollback.

Within a multi-line buffer, arrow keys move the cursor by char (Left/Right)
or by logical line (Up/Down); `Home`/`Ctrl+A` and `End`/`Ctrl+E` jump to
line start and end. `Backspace` and `Delete` operate at the cursor and
join lines when crossing a `\n`. With an empty buffer, `Up`/`Down` continue
to recall input history.

## Steering, queueing and attaching files

- **Steer or queue.** During a run, `Enter` sends the message to the agent at
  its next step. `Tab` holds it for the next turn instead; held messages show
  above the prompt and go out together when the run ends. `Up` at an empty
  prompt takes the newest held message back for editing.
- **Attach a file.** `@path` attaches a file for the agent to read, `#path`
  one it may write. Typing `@` or `#` at the start of a word opens a list of
  matching files (what git tracks plus untracked files it does not ignore;
  a directory walk outside a repository). `↑`/`↓` move, `Tab` or `Enter`
  accepts, `Esc` closes the list. A path with spaces in it goes in double
  quotes (`@"My Vault/Daily Notes.md"`) or has each space escaped
  (`@My\ Vault/today.md`, as a terminal pastes a dropped file); a path
  chosen from the list is quoted for you.

## Notifications

Chimera asks for your attention through the terminal when a run ends, a
permission request opens, or the agent needs input. Set `tui.notifications`
in `~/.chimera/config.json`:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | A bell and an `OSC 9` desktop notification, only when the terminal is not focused. |
| `bell` | A bell on every such event. |
| `off` | Nothing. |

iTerm2, kitty, WezTerm, Ghostty and Windows Terminal show `OSC 9` as a
desktop notification; other terminals ignore it and you get the bell. Focus
comes from the terminal's focus reports. A terminal that sends none gets a
notification for approvals and input requests, and for a finished run only
when the run took ten seconds or more. A run you interrupt yourself sends
nothing. For anything else (a sound, a phone push), use a `Stop` hook; see
[Lifecycle hooks](hooks.md).

## Token usage

- **Context use.** The status line's `context` item shows how full the
  model's context window is after the latest step, as a share of the window
  (`38%/200k`). The numbers are the provider's count, not an estimate.
  `/context` has a breakdown by category.
- **Session totals.** The `tokens` item shows the session's tokens in and out
  (`↑76k ↓3.7k`), and `cache` the share of the last prompt that the provider
  served from its cache. Add them to a status line row to see them. The
  totals are saved with the session.
- **Turn summary.** Each run ends with a `done` row: duration, steps, tool
  calls, tokens in and out, and the cached share.
- **Colours.** The context figure turns the warning colour above 70% and the
  error colour above 90%.
- **The window size.** Chimera knows the window of common Claude and GPT
  models. For another model, set `contextWindow` under `models` in
  `~/.chimera/config.json`; see [Providers](../PROVIDERS.md). Without that
  value the window is assumed to be 128k, and a `?` after the size shows that
  it is approximate.

## Themes

Chimera draws in foreground colours only and never paints the background, so
it sits on your terminal's own theme, light or dark. Two themes ship:

- `default`: the terminal's 16-colour palette. It is what you get with no
  `theme.json`.
- `chimera`: tuned explicit colours, with faint tints behind added and
  removed diff rows.

A theme is a flat set of semantic tokens:

| Token | Used for |
| --- | --- |
| `text` | body text |
| `muted` | tool rows, labels, borders |
| `dim` | hints, the status line, gutters |
| `accent` | your messages, the mode, inline code |
| `info` | notices and links |
| `success`, `warning`, `error` | outcomes; context use above 70% and 90% |
| `diffAdd`, `diffRemove` | added and removed diff rows |
| `diffAddBg`, `diffRemoveBg` | optional tints behind diff rows; set both or neither |
| `keyword`, `string`, `number`, `comment`, `function`, `type` | code blocks |

Each value is an ANSI colour name (`black`, `red`, `green`, `yellow`, `blue`,
`magenta`, `cyan`, `white`, and `brightBlack` to `brightWhite`), `default`
for the terminal's own foreground, or `#rrggbb`. On a terminal without
truecolor (no `COLORTERM=truecolor`), a hex colour is drawn as the nearest
256-colour entry. `NO_COLOR` turns colour off; the hierarchy stays, with
bold and dim.

To override a few tokens, write them to `~/.chimera/theme.json`; the rest
keep the default theme's colours:

```json
{
  "accent": "brightGreen",
  "error": "#ff5f5f"
}
```

Keys starting with `_` are notes (`_comment`). A file in the grouped format
of earlier versions (`{ "accent": { "primary": ... } }`), an unknown token or
a value that is not a colour is refused: the TUI prints `theme: ...` on
stderr at start and uses the default theme.

See [`theme.json.example`](theme.json.example) for a partial override, or
[`theme-dracula.json`](theme-dracula.json) for a full theme.

### Switching between themes

- `/theme` lists the themes; the active one is marked with a leading `*`.
- `/theme <name>` writes that theme into `~/.chimera/theme.json` (with a
  `_themeName` marker so `/theme` can show which is active) and applies it
  without a restart.

Drop more themes into `~/.chimera/themes/<name>.json` to extend the list; a
user file shadows a shipped theme of the same name. Hand-edits to
`~/.chimera/theme.json` take effect on the next start, but `/theme <name>`
overwrites them.
