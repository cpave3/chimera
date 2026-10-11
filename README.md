# Chimera

Chimera is a terminal-native AI coding agent:

See [model generation settings](docs/model-settings.md) for provider capabilities, thinking, effort, session controls, and Manticore setup.

- **TUI-first** for interactive use (Ink-based).
- **SDK-first**: every consumer — the TUI, future Slack harnesses, future subagents — talks to the same `ChimeraClient` over HTTP + SSE, so there is no "side channel" behavior.
- **Permission-aware**: every shell call that would leave the agent's controlled scope is gated. Rules can be remembered for a session, project, or globally.
- **Human handoffs**: agents can call `request_user_input` to end a run with an actionable request and notify integrations through a lifecycle hook.
- **Shape-based providers**: any OpenAI-compatible or Anthropic-compatible endpoint works via `baseUrl` + `apiKey`.

MCP tools (local stdio and remote Streamable HTTP with OAuth), Docker sandbox, skills, user-defined slash commands, and subagents (`spawn_agent`) are supported. See [MCP tools](docs/mcp.md) for setup and host-execution risks.

## Install

### Prerequisites

- Node.js >=20

Enable corepack so the pinned `pnpm` version is used automatically:

```bash
corepack enable
```

### Build

```bash
pnpm install
pnpm -r build
```

### Make `chimera` available globally

Link the repo so the `chimera` binary is on your PATH:

```bash
pnpm link --global
```

Verify:

```bash
chimera --version
```

To remove the global link later:

```bash
pnpm unlink --global
```

### Development fallback

If you prefer not to link globally, run the CLI directly:

```bash
node packages/cli/dist/bin.js <args>
```

## Configure a provider

Create `~/.chimera/config.json`:

```json
{
  "providers": {
    "anthropic": {
      "shape": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "env:ANTHROPIC_API_KEY"
    }
  },
  "defaultModel": "anthropic/claude-opus-4-7"
}
```

See `PROVIDERS.md` for known-good combinations including OpenRouter, local vLLM/Ollama, and Bedrock/Vertex proxies. Host bash risk and filesystem approval policy is documented in [`docs/bash-command-policy.md`](docs/bash-command-policy.md).

## MCP tools

Add local and remote tool servers to `~/.chimera/config.json` with the CLI:

```bash
chimera mcp add local --transport stdio -- node /path/to/server.js
chimera mcp add burnlite --transport http https://burnlite.dev/api/llm/mcp
chimera mcp login burnlite
chimera mcp list
chimera mcp tools burnlite
chimera mcp call burnlite list_projects --args '{}'
```

The HTTP add offers login and a connection test in a terminal; headless add
prints the login command instead. `mcp logout <server>` clears local OAuth
credentials; `mcp remove <server>` also removes its configuration. MCP calls
run on the **host**, even with `--sandbox`, and need separate approval.
Headless use requires an explicit per-server `trustedTools` entry or allow
rule; host auto-approval does not apply. For config examples, OAuth details,
permissions, supported content, and troubleshooting, see [MCP tools](docs/mcp.md).

## Run

Interactive:

```
chimera
```

One-shot:

```
chimera run "run the test suite and fix any failures"
chimera run --json "list the top-level files" > events.ndjson
```

When progress requires a person, the agent can use `request_user_input`. Chimera emits a machine-readable handoff and ends that run without another model step; see [Requesting user input](docs/request-user-input.md).

Start just the server (useful for attaching from another terminal):

```
chimera serve
chimera ls                     # show running instances
chimera attach <pid-or-url>    # future: mount TUI against a running instance
```

Session management:

```
chimera sessions
chimera sessions rm <session-id>
```

## Sandbox

Tool calls can be routed through a Docker container instead of running directly
on the host. Three modes are available:

- `bind` (default with `--sandbox`) — bind-mounts the cwd read-write into the
  container; writes land on the host immediately.
- `overlay` — bind-mounts the cwd read-only and stacks an overlayfs upperdir
  at `~/.chimera/overlays/<sessionId>/`. Writes go to the upperdir, then the
  user reviews and applies them at session end.
- `ephemeral` — like overlay but with a tmpfs upperdir. Nothing persists.

Examples:

```
# Run a one-shot prompt inside a bind-mount sandbox.
chimera run --sandbox "fix the failing tests"

# Apply changes from an overlay run iff the agent finished cleanly.
chimera run --sandbox --sandbox-mode overlay --apply-on-success "refactor X"

# Disable network access and tighten resources.
chimera run --sandbox --sandbox-network none --sandbox-memory 1g --sandbox-cpus 1 "..."

# Refuse to silently fall back to bind when overlay isn't supported.
chimera --sandbox --sandbox-mode overlay --sandbox-strict
```

In overlay mode, the TUI exposes `/overlay` (list pending changes), `/apply`
(interactive picker → rsync), and `/discard`.

The default image is `chimera-sandbox:dev`, built locally from
`packages/sandbox/docker/`. Pre-build it with `pnpm sandbox:build` (or
`chimera sandbox build`); otherwise the first `--sandbox` invocation
auto-builds it once. Pass `--sandbox-image <ref>` to use a different image
— there's no auto-build for non-default tags, so a typo errors immediately.

Overlay/ephemeral modes need `CAP_SYS_ADMIN` and `--security-opt
apparmor=unconfined` on `docker run`. See `SECURITY.md`.

## Filesystem layout

Chimera writes to:

- `~/.chimera/config.json` — read on startup; also holds MCP server definitions under `mcpServers` (not tokens).
- `~/.chimera/mcp-auth/` — owner-only MCP OAuth registration and credentials, keyed by server and exact resource URL.
- `~/.chimera/sessions/<sessionId>/session.json` — per-session metadata (id, parentId, children, cwd, model, sandbox mode, usage). Atomic tmp+rename on every update.
- `~/.chimera/sessions/<sessionId>/events.jsonl` — append-only event log. One JSON object per line. Only `step_finished`, `permission_resolved`, `run_finished`, and `forked_from` events are persisted; transient events (text deltas, tool starts, etc.) are not.
- `~/.chimera/logs/<date>.log` — structured JSON-line activity log. API keys are never written.
- `~/.chimera/instances/<pid>.json` — lockfile for each running server process. Cleaned up on shutdown (and by `chimera ls` on next run).
- `./.chimera/permissions.json` — per-project permission rules (when the user picks "remember for project" in the modal).

> **Breaking change**: prior versions wrote sessions as flat `~/.chimera/sessions/<sessionId>.json` files. Those files are ignored by the current version — they are not migrated and not listed. To recover their contents, open the file directly.

> **Concurrent access**: there is no inter-process locking on a session. If two clients hold the same session id, writes are last-write-wins for `session.json` and atomic-per-line for `events.jsonl` appends. Practically: don't open the same session twice.

See `docs/gitignore-template.md` for recommended `.gitignore` entries.

## Sessions, resume, fork

The TUI exposes three session-management commands:

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

CLI session management:

```
chimera sessions           # list sessions in the current directory
chimera sessions --all     # list every persisted session
chimera sessions rm <id>   # delete a session (rejected if the session has children)
```

## Exit codes for `chimera run`

| Reason         | Code |
| -------------- | ---- |
| stop           | 0    |
| error          | 1    |
| max_steps      | 2    |
| output_limit   | 2    |
| interrupted    | 130  |

## Provider errors, retries, and the response timeout

A model step can fail for reasons that have nothing to do with the task. The
agent loop handles three of them without ending the run:

- **Temporary provider errors** (HTTP 408, 409, 429, 5xx, overload, a dropped
  connection). The step is sent again after a wait, up to four times. The wait
  follows the provider's `retry-after` header (capped at 60 seconds) and
  otherwise doubles from one second. The TUI prints
  `provider error: … — retry 2/4 in 2s`. A step is only retried when none of
  its tool calls had started, so a retry never repeats a side effect.
- **Context overflow.** When the provider rejects a prompt for its length, the
  agent runs one summarizing compaction and sends the step again.
- **Output cutoff.** When an answer stops at the model's output limit, the
  agent asks the model to continue, at most twice per run. If the answer is
  still cut off, the run ends with the reason `output_limit`.

Set `fallbackModel` in `~/.chimera/config.json` to finish a run on a second
model when the first stays unavailable after its retries:

```json
{ "fallbackModel": "anthropic/claude-haiku-4-5" }
```

The fallback applies to the rest of that run only. The next run starts on the
session model again.

`responseTimeoutMs` (default 120000, `0` disables) is an **idle** timeout: it
measures how long the model produces no output. It restarts on every stream
event and is suspended while a tool call is executing, so a long build, test
run, or subagent never trips it. A model that goes silent for the whole
period ends the run with the reason `timeout`.

## Bash timeouts and interruption

Foreground host commands have a 120-second default timeout. On timeout or
interruption, Chimera sends SIGTERM to the command's process group. If cleanup
remains incomplete after two seconds, Chimera sends SIGKILL and allows up to
250 ms for output pipes to close. It then returns the collected output rather
than waiting indefinitely for a child process. Scheduling delays can extend
this cleanup period.

Timeouts return `timed_out: true` and a nonzero exit code. Interruption ends the
agent run; it does not undo command effects. The TUI's `interrupt sent` message
confirms a request, not completed termination.

Detached or elevated children can escape termination. Signal failures and
incomplete pipe cleanup appear in stderr; these commands may still be running.
This bounded cleanup applies to host execution, not Docker sandbox commands.
Use the explicit background tools below for persistent servers and watchers.

## Background processes

The bash tool accepts `run_in_background: true`, which starts the command as a
detached host process and returns a `shell_id` immediately — useful for dev
servers, watchers, and long builds. Two companion tools manage running
processes:

- `bash_output { shell_id }` — returns output produced since the previous
  read, plus the process status and exit code once it has finished.
- `bash_kill { shell_id }` — SIGTERMs the process group, escalating to
  SIGKILL after a grace period.

Background launches go through the same permission gate as foreground host
commands. When a process exits, a `background_process_exited` event is pushed
onto the session's event stream and the TUI prints an info line. All
background processes for a session are killed when the server shuts down.
Background commands always run on the host — `target: 'sandbox'` is refused.

## Model profiles

Chimera adapts its tool names, edit tool and system prompt to the model.
GPT and Codex models edit with `apply_patch`; other models use the
exact-string `edit` tool. Claude, GPT and Codex models get a lean prompt;
any other model gets the same prompt plus a short section of explicit
working rules. The tools section of the prompt is generated from the tools
the session registers. Every default can be set per model under `models` in
`~/.chimera/config.json` — see [model profiles](PROVIDERS.md#model-profiles).

## Tool-call guards

Four guards remove failures that have nothing to do with the task. They
apply to every model.

- **Whitespace-tolerant `edit`.** When `old_string` has no exact match, `edit`
  matches it against whole lines, first ignoring trailing whitespace and then
  indentation, and applies the change when exactly one place matches. If the
  indentation was wrong, the replacement is re-indented to the file. The
  scrollback line says `matched ignoring whitespace`. When nothing matches,
  the error shows the closest block of the file with line numbers.
- **Tool-call repair.** Arguments sent as a JSON string, wrapped in a code
  fence, with `"true"` or `"5"` where the schema wants a boolean or a number,
  or with `null` for an optional field are corrected before validation. So
  is a tool name in the wrong case or under a common alias (`shell`,
  `read_file`). A call that is still invalid goes back to the model as an
  error.
- **Repeat note.** When the model sends the same call three times in a row
  and gets the same outcome, the result carries a note that tells it to
  change approach.
- **Output budget.** One tool result may take 8% of the model's context
  window (at least 2,000 and at most 25,000 tokens). A larger result keeps its
  shape, but each oversized text field is cut to its beginning and end and
  each oversized list to its first items. The full content goes to the recall
  store, and the model can page through it with `recall({ id, start_line,
  end_line })` or `recall({ id, search })`. The scrollback shows
  `output shortened (12k tokens); full text archived as pr_…`. Images and
  `recall` results are never shortened.

## Post-edit diagnostics

After every successful `edit`/`write`, Chimera can run fast project checks
against the changed file and feed failures back to the model **inside the tool
result** — so type errors and lint breakage get fixed in the same step that
caused them instead of surfacing steps later.

Checks are auto-detected from project config files:

- **biome** — when `biome.json`/`biome.jsonc` and the local
  `node_modules/@biomejs/biome` binary exist, changed JS/TS/JSON/CSS files are
  checked with `biome check <file>`.
- **cerberus** — when `.cerberus/config.yaml` exists, `cerberus run quick`
  runs after each change.

Add or override checks in `~/.chimera/config.json` (`{file}` expands to the
shell-quoted changed path; exit 0 means clean, anything else feeds the
command's output to the model, clipped to 4 kB):

```json
{
  "diagnostics": {
    "checks": [
      { "name": "tsc", "command": "node ./node_modules/typescript/bin/tsc --noEmit", "match": "\\.tsx?$" }
    ]
  }
}
```

Set `"diagnostics": { "enabled": false }` to turn the feature off, or
`"autoDetect": false` to keep only your explicit checks. Heavy checks (tsc,
test suites) are deliberately not auto-detected — they run on every edit, so
opt in only where the project is small enough.

## Context management

Chimera is geared for models with 100–250k context windows. Three layers keep
long sessions inside budget (full details in `docs/COMPACTION.md`):

- **Mid-run auto-compaction.** The agent projects the next prompt from the
  provider's *actual* reported token usage (falling back to a char/4 estimate
  before the first step) and compacts when it crosses
  `min(window × thresholdPercent, window − reserve)` — checked at run start
  **and between steps**, so long tool loops never die on a window overflow.
  Configure with `compaction.thresholdPercent` (default 85).
- **Tiered compaction.** Phase 1 archives old large tool outputs to the
  recall store and leaves `recall({ id: "pr_..." })` stubs in place — no LLM
  call, and the conversation skeleton survives. Only if that isn't enough
  does phase 2 summarize the oldest messages. The `recall` tool fetches
  archived outputs back (with `start_line`/`end_line`/`search` slicing);
  entries live under `~/.chimera/recall/<sessionId>/` and expire after
  `recall.ttlDays` (default 30). Disable with `"recall": { "enabled": false }`.
- **`/context`.** Shows the window, the actual last-prompt size, the current
  estimate, the auto-compact trigger, and a per-category breakdown (system
  prompt, summary, user/assistant messages, tool results, archived stubs).

## Project instructions

Chimera puts `AGENTS.md` (or `CLAUDE.md` where there is no `AGENTS.md`) and
`AGENTS.local.md` into the system prompt, from the working directory up to
the git root. You do not have to tell the agent to read them.

- **Subdirectories.** A package deeper in the tree can have its own
  instruction file. The first time the agent reads, edits or writes a file in
  such a directory, the tool result carries that file (and those of the
  directories between it and the working directory), once a session. The
  system prompt does not change, so the provider's cache stays valid.
- **Size limit.** An instruction file adds at most 32 KiB to the context. A
  larger file is cut at a line boundary with a note for the model, and the
  TUI tells you at start. Keep the file short and point to longer documents
  the agent can read when it needs them.
- **Skills.** The skill index takes at most 2% of the model's context
  window. A library too large for that is listed by name per skills
  directory, without descriptions; the agent can still open any skill.
- **`/reload`** composes the system prompt again from disk for the session on
  screen: instruction files, skills, mode and tool list as they are now.

## Task list

For multi-step work the model maintains a task list via the `task_list` tool
(replace-whole-list semantics, statuses `pending` / `in_progress` /
`completed`). During a run the task panel above the prompt shows the task in
progress and what follows; the footer keeps the count and the task in progress
(`tasks 2/5 · ◼ implement feature`). The
list is persisted in session
metadata, so it survives resume, forks, and context compaction. The model
sees the list through its latest `task_list` call; when compaction summarizes
that call away, the summary ends with a `<tasks>` block that restates every
task and status. The list is deliberately not part of the system prompt, so a
task update does not invalidate the provider's prompt cache. Scrollback
renders each update as a compact progress line (`2/5 done → current task`).

Plan mode hands off into this: the model presents its plan as a numbered
markdown list, and when you accept it (switch out of plan mode), a one-shot
system note on the next run tells it to record the plan via `task_list` and
execute against it.

## Web access

Two tools give the agent eyes outside the working tree:

- **`fetch`** — always registered. GETs an http(s) URL, converts HTML to
  readable markdown-ish text (dependency-free converter), follows redirects,
  clips to 50k chars by default. Every call goes through the permission gate
  (`tool: fetch`, command = URL), so the usual remember-for-session /
  remember-for-project rules apply to domains you trust.
- **`web_search`** — registered only when a search backend is configured in
  `~/.chimera/config.json`:

  ```json
  {
    "webSearch": {
      "provider": "searxng",
      "baseUrl": "http://localhost:8080/"
    }
  }
  ```

  Supported providers: `searxng`, `tavily`, `brave`. SearXNG instances must
  enable JSON output. For Tavily and Brave, use `apiKey` instead of `baseUrl`;
  `env:VAR_NAME` values resolve from the environment at call time.

  The configured provider is the session's only search backend; Chimera does
  not fall back to another provider on failure. Results come back as
  title/URL/snippet triples. When `web_search` is active, the model is told not
  to guess URLs: it should search first, then pass an exact returned URL to
  `fetch`. Existing URLs supplied by the user or trusted context can be fetched
  directly.

## Subagents

The `spawn_agent` tool lets a parent agent delegate a focused task to a fresh
Chimera instance. By default subagents run as a separate `chimera serve`
process so they show up in `chimera ls` and are observable from another
terminal — see [SUBAGENTS.md](./SUBAGENTS.md) for the full debugging workflow.

```
# Cap nesting at 5 levels (default 3).
chimera --max-subagent-depth 5

# Disable the spawn_agent tool entirely for a session.
chimera --no-subagents
```

### The `explore` agent

Chimera ships one agent definition, `explore`: a read-only search helper with
`read`, `glob`, `grep`, `fetch` and `web_search`. The model is told to give it
a wide search (many files, or a place it does not know yet) and to work from
the findings, which carry `path:line` references. The file contents then stay
out of the main context. To change it, put your own `explore.md` in
`~/.chimera/agents/` or `<cwd>/.chimera/agents/`; yours replaces the built-in
one.

### A cheaper model for helper work

```json
{ "utilityModel": "anthropic/claude-haiku-4-5" }
```

`utilityModel` names one low-cost model for helper work. An agent definition
selects it with `model: utility` in its frontmatter, as `explore` does.
Compaction summaries use it too, unless `compaction.model` is set. Without
the key, helper work runs on the session model. A reference that cannot be
resolved gives one warning and is ignored.

### Background agents

`spawn_agent` normally waits for the child. With `background: true` the call
returns at once with the child's id, and the model goes on working. When the
child ends, Chimera puts its answer into the conversation: at the next step
of a run in progress, or as the start of a new run when the session is idle.
The transcript shows `background agent done: <purpose>` at that point.

- `agent_status` lists the session's background agents (id, purpose, state,
  running time) and, for one id, its final answer. `agent_stop` stops one.
- A background agent goes on when the run that started it ends or is
  interrupted. It stops when it is done, when the model stops it, or when the
  session ends.
- A background agent cannot ask you for approval. A command that needs
  approval is denied, and the agent is told so.
- `chimera run` ends with its run, so there a `background: true` call runs in
  the foreground and the result says so.

## The TUI screen

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
  ● edit src/yg/commands/list.ts (1 replacement)                    sandbox                off
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
    › message chimera
                                                                    PEERS
   BUILD   enter steer · tab queue · esc interrupt                  ● api          plan · idle
                                                                    ↑ 3.2k ↓ 640     cache 81%
```

- **Transcript pane.** It follows the newest output. `PgUp`, `PgDn` and the
  mouse wheel scroll it; while you are scrolled away, new output does not
  move what you read. `PgDn` to the end, or sending a message, follows the
  newest output again. A long session mounts the newest entries only and
  loads earlier ones when you scroll up from the top.
- **Context panel.** Model, session, working directory, sandbox, and what was
  loaded; context use as a bar split into system prompt, skills index and
  history (the split is an estimate; the total is the provider's count); the
  plan (the model's task list); the working tree (branch, commits ahead and
  behind, changed files with lines added and removed); other live Chimera
  instances on this machine with their mode and state; and the session's
  token totals with the cached share of the last prompt. `Ctrl+B` hides and
  shows the panel. Under 100 columns the panel is dropped, and the hints row
  shows the model and the context percentage instead.
- **Prompt box and hints row.** The row under the prompt shows the mode as a
  badge and the keys that matter in the current state.
- **Mouse.** Chimera takes the wheel only. Select text with the terminal as
  usual, with `Shift` held (`Option` in iTerm2). Set `tui.mouse` to `false`
  to leave the mouse to the terminal; the wheel then does not scroll.
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
build · anthropic/claude-opus-4-7 · sandbox off   ▰▰▰▰▱▱▱▱▱▱ 42% · 84k/200k · cache 81%
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
  more. Tool calls that follow each other sit together. When a sandbox is
  active the line also says `[host]` or `[sandbox]`. Consecutive successful
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
- **Approvals.** A permission request is a list: `↑`/`↓` and `Enter`, a
  digit, or the letter shown next to each choice. `Esc` denies.

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
[Lifecycle hooks](docs/hooks.md).

## Token usage

The context panel (the first footer row in the inline layout) shows how full
the model's context window is after the latest step: a gauge with a
percentage, and the tokens used over the window size (`84k/200k`). With it
is the share of the last prompt the provider served from its cache
(`cache 81%`). The numbers come from the AI SDK's
`usage` payload — no estimation, no extra calls. `/context` has a
per-category breakdown. Cumulative totals persist with the session, so
resuming an old session shows the same figures on the next prompt.

Color escalates as the prompt fills the window: gray under 80%, amber from
80–95%, red at 95% or above. The window itself is resolved from a built-in
table for known Claude / GPT / o-series models. To override (or add a model
we don't know about yet), set a `models` block in `~/.chimera/config.json` —
see `PROVIDERS.md`. When the model isn't in the table and you haven't set
an override, the window falls back to 128k and a `?` after the window size
flags the value as approximate.

## What's not here (yet)

- No MCP resources, prompts, or legacy SSE transport (MCP tools only).
- No bearer-token auth on the HTTP server. Bind is `127.0.0.1` only by default.

## Theme Customization

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

See `docs/theme.json.example` for an annotated partial-override sample, or `docs/theme-dracula.json` for a full re-skin.

### Switching between themes

The TUI ships a few bundled presets: `default`, `tokyo-night-moon`, and `cyberpunk`. From inside the TUI:

- `/theme` — list available themes; the active one is marked with a leading `*`.
- `/theme <name>` — write the chosen preset into `~/.chimera/theme.json` (with a `_themeName` marker so `/theme` can show which is active) and live-reload without restarting.

Drop additional partial themes into `~/.chimera/themes/<name>.json` to extend the list; user files shadow bundled presets of the same name. Hand-edits to `~/.chimera/theme.json` always take effect on next start, but running `/theme <name>` overwrites them.

## Lifecycle hooks

Drop an executable file in `~/.chimera/hooks/<EventName>/` (global) or `<cwd>/.chimera/hooks/<EventName>/` (project) and Chimera fires it on the matching event. Events: `UserPromptSubmit`, `PostToolUse`, `PermissionRequest`, `Stop`, `SessionEnd`. `chimera hooks list` prints what's installed. See [`docs/hooks.md`](docs/hooks.md) for the payload schema, exit-code semantics, and a Legato integration recipe.

## Packages

```
packages/core          — agent loop, events, session persistence
packages/providers     — OpenAI/Anthropic-compat provider factories
packages/tools         — Executor, LocalExecutor, bash/read/write/edit
packages/permissions   — rule store, GatedExecutor, auto-approve tiers
packages/hooks         — lifecycle hook discovery + execution
packages/sandbox       — DockerExecutor, overlay diff/apply, sandbox image
packages/server        — Hono HTTP + SSE surface
packages/client        — typed TypeScript SDK (ChimeraClient)
packages/tui           — Ink-based interactive UI
packages/cli           — chimera binary
```

Dependency DAG is strict: `cli → tui, server, client, permissions, hooks, sandbox, tools, providers, core`. No back edges.
