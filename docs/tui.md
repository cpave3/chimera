# The TUI

The interactive `chimera` command opens the TUI. This page describes the
screen, the keys, the commands, the prompt, notifications and themes.

## Keys

`?` at an empty prompt shows this list in the TUI.

| Key | Action |
| --- | --- |
| `Enter` | Send. During a run: steer the agent. |
| `Tab` | During a run: hold the message for the next turn. |
| `\` then `Enter` | New line (also `Shift+Enter` or `Alt+Enter` where the terminal supports it). |
| `Ctrl+G` | Edit the prompt in `$EDITOR`. |
| `Ctrl+V` | Paste an image from the clipboard. |
| `Ctrl+T` | Open the full transcript in a pager. |
| `Up` / `Down` | Prompt history. |
| `Shift+Tab` | Cycle the mode. |
| `/` | Commands; `Tab` completes. |
| `@path`, `#path` | Attach a file to read, or a file to write. |
| `!command` | Run a shell command yourself. The output goes into the conversation. |
| `Esc` | Interrupt the run. |
| `Ctrl+C` | Interrupt; press it twice to exit. |
| `Ctrl+Z` | Suspend. |
| `PgUp` / `PgDn`, mouse wheel | Scroll the transcript (fullscreen). |
| `Ctrl+B` | Show or hide the context panel (fullscreen). |
| Drag | Select text; it is copied when you release the button (fullscreen). |

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
| `/add-read-path <path>`, `/add-write-path <path>` | Grant access to a file or directory outside the project. |
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

The TUI has two layouts. **Fullscreen** is the default: it takes the
terminal's alternate screen and keeps a context panel beside the transcript.
**Inline** prints into the terminal's own scrollback and repaints only a few
rows under it; use it on a slow link (for example SSH with high latency) or
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

```
  › add a --json flag to yg list and cover it with a test          ◆ chimera v0.1.0
                                                                    model        manticore/gpt
  ● read 1 file · 1 search                                          session           8AWWBRGC
    src/yg/commands/list.ts (120 lines), "formatWorktree" · 3 …     cwd     ~/Projects/yggdrasil
  ● edit src/yg/commands/list.ts (1 replacement)                    sandbox                 os
    ╭──────────────────────────────────────────────────────────╮    loaded  60 skills · 9 cmds
    │ 44 +   if (opts.json) return print(JSON.stringify(trees… │
    │ 45     const rows = trees.map(formatWorktree)            │    CONTEXT · 76k / 200k   38%
    ╰──────────────────────────────────────────────────────────╯    ▄▄▄▄▄▄▄▄▄▄▄▄▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁
  ● bash pnpm vitest run yg/list (exit 0) · 4.2s                    ■ system ■ skills ■ history
    ✓ 14 passed
                                                                    PLAN · 2/4
  ◆ Added --json to yg list. Writing a snapshot test next.          ✓ locate list command
                                                                    ✓ add --json option
  ○ write src/yg/commands/list.test.ts                              ▸ snapshot test for JSON shape
                                                                    ○ update README usage

                                                                    WORKTREE
                                                                    yg/json-flag            ↑1
  ⠹ write src/yg/commands/list.test.ts · 12s · step 6 · esc to …    M list.ts           +18 −3
                                                                    A list.test.ts

                                                                    PEERS
                                                                    ● api          plan · idle
                                                                    total                 3.8k
    › message chimera                                               in      3.2k  out      640
   BUILD   enter steer · tab queue · esc interrupt                  cache                  81%
```

- **Transcript pane.** It follows the newest output. `PgUp`, `PgDn` and the
  mouse wheel scroll it; while you are scrolled away, new output does not
  move what you read. `PgDn` to the end, or sending a message, follows the
  newest output again. A long session mounts the newest entries only and
  loads earlier ones when you scroll up from the top.
- **Context panel.** Model, session, working directory, sandbox (`os` when host
  commands run in the OS sandbox, a Docker mode, or `off`), and what was
  loaded; context use as a bar split into system prompt, skills index and
  history (the split is an estimate; the total is the provider's count); the
  goal, when one is set (see [Goals](goals.md)); the
  plan (the model's task list); the working tree (branch, commits ahead and
  behind, changed files with lines added and removed); other live Chimera
  instances on this machine with their mode and state; and the session's
  tokens: the total, then `in` and `out` side by side, then the cached share
  of the last prompt. `Ctrl+B` hides and
  shows the panel. Under 100 columns the panel is dropped, and the hints row
  shows the model and the context percentage instead.
- **Prompt box and hints row.** The row under the prompt shows the mode as a
  badge and the keys that matter in the current state.
- **Mouse.** The wheel scrolls the transcript. Drag with the left button to
  select text: the selection is copied to the clipboard when you release the
  button, and the hints row says how much was copied. A selection stays in
  the column it starts in, so a copy from the transcript never takes the
  panel along, and code keeps its shape (later lines lose the indent the
  first line starts at). The copy goes through the system clipboard tool
  (`wl-copy`, `xclip`, `xsel`, `pbcopy`) and through the terminal's own
  clipboard sequence (OSC 52), which is what reaches your machine over SSH.
  In tmux, OSC 52 needs `set -g set-clipboard on`; the system tool needs
  nothing. A selection covers what is on screen; for more, scroll and copy
  again, or open the transcript with `Ctrl+T`. `Shift`+drag still gives you
  the terminal's own selection (`Option` in iTerm2). Set `tui.mouse` to
  `false` to leave the mouse to the terminal entirely; the wheel then does
  not scroll.
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

- **Transcript lines.** A user message starts with `›` and assistant text
  with `◆`. A tool call starts with a glyph for its state (`○` running, `●`
  returned, `✗` failed or exited non-zero) and shows a one-line summary
  instead of raw JSON args, with the duration when the call took a second or
  more. Tool calls that follow each other sit together. When a Docker
  sandbox is active the line also says `[host]` or `[sandbox]`. Consecutive successful
  `read`, `glob`, `find`, `ls` and `grep` calls collapse into one line. An
  edit, a patch or a written file is drawn in a border. Fenced code blocks
  with a known language are syntax-highlighted.
- **Turn summary.** Each run ends with one line: duration, steps, tool calls,
  tokens in and out, and the cached share.
- **Full transcript.** `Ctrl+T` opens the whole session in a pager (`$PAGER`,
  else `less`): every tool call on its own line, with its full output.
- **Activity line.** While a run is active, one line says what the agent is
  doing (thinking, writing, running a tool, waiting for approval, compacting,
  retrying a provider error), for how long, on which step, and how many
  tokens it has produced.
- **Help.** `?` at an empty prompt lists the key bindings.
- **Reviewer mark.** A tool line that the approval reviewer allowed ends with
  `approved by reviewer`. See
  [Host bash command policy](bash-command-policy.md#approval-reviewer).
- **Notices.** Results of goal checks, background agents and compactions are
  one line each, wrapped between words.
- **Approvals.** A permission request is a list: `↑`/`↓` and `Enter`, a
  digit, or the letter shown next to each choice. `Esc` denies.
  For an OS sandbox bypass, choose **Allow once**, **Allow exact command…**, or
  **Allow command prefix…**. Review the pattern and choose session, project, or
  global scope. See [OS sandbox](sandbox.md#os-sandbox) for the limits.

Each built-in tool ships with a `formatScrollback` hook in its definition
that produces an args-only summary at call start and a result-aware summary
once the tool returns. Plugin tools authored via `defineTool` from
`@chimera/tools` opt in by passing `formatScrollback`; tools without one
fall back to a `<name> <truncated-JSON>` rendering.

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
  accepts, `Esc` closes the list.

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

- **Context use.** The context panel (the first footer row in the inline
  layout) shows how full the model's context window is after the latest
  step: a bar or gauge with a percentage, and the tokens used over the window
  size (`84k / 200k`). The numbers are the provider's count, not an estimate.
  `/context` has a breakdown by category.
- **Session totals.** The bottom of the context panel shows the `total`
  tokens of the session, then `in` and `out` side by side, then `cache`: the
  share of the last prompt that the provider served from its cache. The
  totals are saved with the session.
- **Turn summary.** Each run ends with one line: duration, steps, tool calls,
  tokens in and out, and the cached share.
- **Colours.** The percentage is gray under 80%, amber from 80% to 95%, and
  red from 95%.
- **The window size.** Chimera knows the window of common Claude and GPT
  models. For another model, set `contextWindow` under `models` in
  `~/.chimera/config.json`; see [Providers](../PROVIDERS.md). Without that
  value the window is assumed to be 128k, and a `?` after the size shows that
  it is approximate.

## Themes

The TUI loads a user theme from `~/.chimera/theme.json`, alongside the rest of Chimera's user state (sessions, config, logs). Create the file to override any subset of the default colour tokens:

```json
{
  "accent": {
    "primary": "green",
    "secondary": "cyanBright"
  },
  "status": {
    "error": "redBright"
  },
  "text": {
    "muted": "gray"
  }
}
```

Only specify the tokens you want to override; the rest inherit from the default theme. Available token groups:

- `base` — `foreground`, `background`
- `accent` — `primary`, `secondary`, `tertiary`
- `status` — `success`, `warning`, `error`, `info`, `successBg`, `errorBg` (diff rows)
- `text` — `primary`, `secondary`, `muted`, `dim`
- `ui` — `badge`, `accent`
- `syntax` — `keyword`, `string`, `comment`, `number`, `function`, `type` (fenced code blocks)
- `surface` — `panel`, `raised`, `sunken`, `border` (fills and lines of the fullscreen layout)

The two layouts start from different defaults. The fullscreen layout paints its own background, so its default theme is a set of explicit colours (background `#1f1d27`, accent `#b79cf7`) with fills for the panel and the prompt box. The inline layout sits on your terminal's background, so its default theme uses ANSI colour names and no fills. Your `theme.json` merges over whichever applies. A surface with no colour is drawn without a fill; set `base.background` and the `surface` colours together when you re-skin the fullscreen layout. `NO_COLOR` gives both layouts a plain theme with no fills.

JSON has no native comments, so the loader strips unknown top-level keys — you can leave a `_comment` field in the file as a note. If the JSON is malformed, the TUI prints `theme: ...` on stderr at startup and falls back to the default theme.

See [`theme.json.example`](theme.json.example) for an annotated partial-override sample, or [`theme-dracula.json`](theme-dracula.json) for a full re-skin.

### Switching between themes

The TUI ships a few bundled presets: `default`, `tokyo-night-moon`, and `cyberpunk`. From inside the TUI:

- `/theme` — list available themes; the active one is marked with a leading `*`.
- `/theme <name>` — write the chosen preset into `~/.chimera/theme.json` (with a `_themeName` marker so `/theme` can show which is active) and live-reload without restarting.

Drop additional partial themes into `~/.chimera/themes/<name>.json` to extend the list; user files shadow bundled presets of the same name. Hand-edits to `~/.chimera/theme.json` always take effect on next start, but running `/theme <name>` overwrites them.
