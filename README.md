# Chimera

Chimera is an AI coding agent for the terminal. You give it a task in your
project. It reads the code, runs commands, edits files, and tells you what it
did. It works with any OpenAI-compatible or Anthropic-compatible model, from a
large hosted model to a small local one.

- **A TUI for interactive work.** A fullscreen layout with a transcript and a
  context panel, or an inline layout for slow links.
- **Any model.** Chimera adapts its tools and its prompt to the model, and
  repairs the common mistakes that small models make in tool calls.
- **Safe by default.** Host commands run in an OS sandbox. A command policy
  and approval prompts control what leaves it.
- **Long sessions.** Automatic compaction, an archive for large tool outputs,
  and a memory for each project.
- **Work without supervision.** Goals that are checked at each stop, an
  optional approval reviewer, and subagents that run in the background.
- **Open to extension.** MCP tools, lifecycle hooks, skills, your own slash
  commands, modes, agent definitions and themes.
- **Scriptable.** `chimera run` for one prompt, `chimera serve` for a server,
  and a typed client. The TUI uses the same HTTP interface.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Daily use](#daily-use)
- [Models](#models)
- [Tools](#tools)
- [Safety](#safety)
- [Context and memory](#context-and-memory)
- [Goals, questions and subagents](#goals-questions-and-subagents)
- [Extend Chimera](#extend-chimera)
- [Configuration](#configuration)
- [Commands](#commands)
- [Documentation](#documentation)
- [Development](#development)
- [Limits](#limits)

## Install

On Linux (x86_64, aarch64) or a Mac with Apple silicon:

```bash
curl -fsSL https://raw.githubusercontent.com/cpave3/chimera/main/install.sh | sh
chimera --version
```

The script puts one binary in `~/.local/bin/chimera`, after checking it
against the release's checksums. It needs no Node.js. `chimera update`
installs a newer release, and a release build keeps itself current in the
background. Manual downloads, updates, running from source and uninstalling
are in [docs/install.md](docs/install.md).

On Linux, install `bubblewrap` to get the [OS sandbox](#safety). Without it
Chimera shows one warning and runs commands unsandboxed.

## Quick start

1. Create `~/.chimera/config.json` with one provider and a default model:

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

   [`PROVIDERS.md`](PROVIDERS.md) has examples for OpenAI-compatible
   endpoints, OpenRouter, local servers and proxies.

2. Start Chimera in your project:

   ```bash
   cd my-project
   chimera
   ```

3. Type a task and press `Enter`. Then try:

   | Try | To |
   | --- | --- |
   | `?` at an empty prompt | See the keys |
   | `/help` | See the commands |
   | `Shift+Tab` | Switch between `build` and `plan` mode |
   | `@src/file.ts` in a message | Attach a file |
   | `Esc` | Stop the agent |

## Daily use

### The TUI

```
chimera                  # fullscreen layout
chimera --inline         # print into the terminal's scrollback
chimera -m provider/model
chimera --mode plan
```

The fullscreen layout shows the transcript beside a context panel: model,
session, sandbox, context use, goal, plan, working tree, other running
instances and token totals.

| Key | Action |
| --- | --- |
| `Enter` | Send. During a run: steer the agent. |
| `Tab` | During a run: hold the message for the next turn. |
| `Esc` | Interrupt the run. |
| `Shift+Tab` | Cycle the mode. |
| `Ctrl+T` | Open the full transcript in a pager. |
| `Ctrl+B` | Show or hide the context panel. |
| `Ctrl+G` | Edit the prompt in `$EDITOR`. |
| `Ctrl+V` | Paste an image. |
| `@path`, `#path` | Attach a file to read, or a file to write. |
| `!command` | Run a shell command yourself and put the output into the conversation. |
| `PgUp` / `PgDn`, mouse wheel | Scroll the transcript. |
| Mouse drag | Select text; it is copied when you release the button. |

The most used commands are `/new`, `/sessions`, `/rewind`, `/model`, `/mode`,
`/goal`, `/context`, `/compact` and `/memory`. [The TUI](docs/tui.md) has the
complete key and command lists, the two layouts, notifications and themes.

### Modes

A mode sets the tools and the instructions of the agent. Two modes are built
in:

- **`build`** (default): all tools.
- **`plan`**: read-only. The agent reads the project, searches the web and
  can give a wide search to the `explore` subagent. It cannot edit a file or
  run a command. It ends with a numbered plan. When you switch back to
  `build`, the agent records the plan in its task list and works through it.

`Shift+Tab` or `/mode <name>` switches. You can write your own modes; see
[Modes](docs/MODES.md).

### One prompt

```bash
chimera run "run the test suite and fix the failures"
chimera run --json "list the top-level files" > events.ndjson
chimera run --goal "pnpm test passes" "fix the failing tests"
```

The exit code says how the run ended. See [Headless use](docs/headless.md)
for the codes, the approval rules of a one-shot run, the server
(`chimera serve`, `chimera ls`, `chimera attach`) and the HTTP API.

### Sessions

Chimera saves each session. You can continue one, fork it, or go back to an
earlier message.

```bash
chimera -c               # continue the newest session of this directory
chimera --resume         # pick a session of this directory
chimera sessions list    # list the saved sessions
```

In the TUI, `/sessions` switches, `/fork` makes a child session, and
`/rewind` goes back to an earlier message and restores the working tree to
that point. See [Sessions and files](docs/sessions.md).

## Models

- **Providers.** A provider is a `baseUrl`, an `apiKey` and a `shape`
  (`anthropic` or `openai`). A model reference is `provider/model`. See
  [`PROVIDERS.md`](PROVIDERS.md).
- **Model profiles.** Chimera selects the edit tool, the tool names and the
  prompt style for each model. GPT and Codex models edit with `apply_patch`.
  Other models use the exact-string `edit` tool. Models other than Claude,
  GPT and Codex get a short list of explicit working rules. You can set each
  of these for a model. See
  [model profiles](PROVIDERS.md#model-profiles).
- **Generation settings.** Thinking, effort and other settings are in
  [Model generation settings](docs/model-settings.md). `/model` changes the
  model and its settings in a session.
- **Helper models.**

  | Key | Use |
  | --- | --- |
  | `utilityModel` | One low-cost model for helper work: the `explore` subagent, the approval reviewer, the goal check and compaction summaries. |
  | `fallbackModel` | Finishes a run when the session model stays unavailable after its retries. |
  | `defaultVisionModel` | Takes a turn that has an image when the session model cannot read images. |

- **Updates.** A release build keeps itself current in the background;
  `updates.mode` is `auto`, `ask` or `off`. See
  [Background updates](docs/install.md#background-updates).
- **Failures that are not your task.** Chimera retries temporary provider
  errors, compacts and tries again when a prompt is too long, and asks the
  model to continue when an answer is cut off. The response timeout measures
  model silence only, so a long build does not trip it. See
  [Errors, retries and the response timeout](PROVIDERS.md#errors-retries-and-the-response-timeout).
- **Prompt caching.** The system prompt does not change during a session, and
  Anthropic-shape providers get cache markers. The TUI shows the cached share
  of each prompt. See [Prompt caching](PROVIDERS.md#prompt-caching).

## Tools

The agent has these tools: `bash`, `read`, `write`, `edit` or `apply_patch`,
`glob`, `grep`, `fetch`, `web_search` (when a search provider is configured),
`task_list`, `recall`, `ask_question`, `request_user_input`, `spawn_agent`,
tools for background processes and background subagents, and the tools of
your MCP servers.

Four guards apply to every model:

- **Whitespace-tolerant edit.** An edit that differs from the file only in
  whitespace is applied when exactly one place matches.
- **Tool-call repair.** Arguments with a wrong type or in a code fence, and
  tool names under a common alias, are corrected.
- **Repeat note.** After three identical calls with the same result, the
  agent is told to change its approach.
- **Output budget.** A large tool result is shortened. The full text goes to
  an archive that the agent reads with `recall`.

After each edit, Chimera can run fast project checks (for example `biome`)
and give the failures to the model in the same step.

See [Tools](docs/tools.md) for the tool table, the guards, post-edit
diagnostics, bash timeouts, background processes and web access.

## Safety

Chimera has three layers between the model and your machine.

1. **The OS sandbox.** Each host `bash` command runs in the sandbox of the
   operating system (`bubblewrap` on Linux, `sandbox-exec` on macOS). The
   command can read every file. It can write only in the project, the temp
   directory, the paths that you granted and the repository's git directory.
   It cannot write `.chimera/`, where the rules and hooks are. When the
   sandbox blocks a command, the agent can ask to run it unsandboxed, and
   that request needs approval. The macOS profile was not run on a Mac.
2. **The command policy.** Chimera analyzes each host command before it runs.
   Sudo and dangerous commands need your approval. Without the OS sandbox, a
   write outside the allowed directories also needs it. Some commands are
   always blocked. You can remember a decision for the session, the project
   or all projects. Each decision is in an audit log.
3. **Approval prompts.** The prompt shows the command and the findings. With
   `"approvalReviewer": { "enabled": true }`, the `utilityModel` examines a
   request first: it allows what is plainly part of your task and sends the
   rest to you. With `"systemOne": { "enabled": true, "jev": { "apiKey": "…" } }`,
   a System One model (Jev or a compatible server) rates a bash command
   first: a command that it rates safe runs, and the rest go to you with a
   note. Sudo and dangerous commands always go to you.

For more isolation, `--sandbox` moves the tools into a Docker container, with
`bind`, `overlay` (review the changes before they reach your files) and
`ephemeral` modes.

`--auto-approve none|sandbox|host|all` sets what runs without a prompt. The
default is `host`: a host command that the policy accepts runs at once.

- [Sandboxes](docs/sandbox.md): the OS sandbox and the Docker sandbox.
- [Host bash command policy](docs/bash-command-policy.md): the rules, sudo,
  the approval reviewer, the System One check and the audit log.
- [`SECURITY.md`](SECURITY.md): the threat model.

## Context and memory

- **Project instructions.** Chimera loads `AGENTS.md` (or `CLAUDE.md`) and
  `AGENTS.local.md` from the working directory up to the git root. An
  instruction file in a subdirectory is loaded when the agent first works
  there.
- **Project memory.** The agent keeps a small memory for each project in
  `~/.chimera/projects/<id>/memory/`: your preferences and corrections. Each
  session loads the index. `/memory` opens it in your editor.
- **Compaction.** Before the context window is full, Chimera first archives
  old large tool outputs and then summarizes the oldest messages. This
  happens between steps, so a long tool loop does not fail on a full window.
  `/context` shows where the tokens are, and `/compact` compacts now.
- **Task list.** For work with several steps the agent keeps a task list. The
  TUI shows it, and it stays through compaction, resume and fork.

See [Instructions, memory and context](docs/context.md) and
[Context compaction](docs/COMPACTION.md).

## Goals, questions and subagents

- **Goals.** `/goal <condition>` or `chimera run --goal` states when the work
  is done, for example `pnpm test passes`. At each stop, a checker model
  examines the goal against the tool results. If the goal is not met, the
  agent gets the reason and continues, up to a limit. See
  [Goals](docs/goals.md).
- **Questions.** The agent can ask you one to four multiple-choice questions
  in a dialog and continue with your answers. When it cannot continue without
  you, it ends the run with a request. See
  [Requesting user input](docs/request-user-input.md).
- **Subagents.** The agent can give a focused task to a child agent with its
  own context. The built-in `explore` agent does wide read-only searches, so
  the file contents stay out of the main context. A subagent can run in the
  background while the agent continues. See [Subagents](SUBAGENTS.md).

## Extend Chimera

| Extension | What it is | Where it goes | Docs |
| --- | --- | --- | --- |
| MCP servers | Tools from local and remote servers, with OAuth | `chimera mcp add …` | [MCP tools](docs/mcp.md) |
| Hooks | Executables that run on events such as `PreToolUse`, `Stop` and `SessionEnd`; some can block | `.chimera/hooks/<Event>/` | [Lifecycle hooks](docs/hooks.md) |
| Skills | Instructions with files that the agent loads when a task needs them | `.chimera/skills/<name>/SKILL.md` | [Skills](SKILLS.md) |
| Commands | Your own slash commands: prompt templates with arguments | `.chimera/commands/<name>.md` | [User commands](docs/COMMANDS.md) |
| Modes | A tool list and instructions that you switch to | `.chimera/modes/<name>.md` | [Modes](docs/MODES.md) |
| Agents | Definitions for subagents: prompt, tools and model | `.chimera/agents/<name>.md` | [Subagents](SUBAGENTS.md) |
| Themes | Colours of the TUI | `~/.chimera/theme.json` | [The TUI](docs/tui.md#themes) |

Each directory can be in the project (`<cwd>/.chimera/`) or in your home
directory (`~/.chimera/`). Chimera also reads skills, commands, modes and
agent definitions from `.claude/`, so files written for Claude Code work.
`--no-claude-compat` turns that off.

`chimera skills`, `chimera commands`, `chimera agents` and
`chimera hooks list` show what Chimera found in the current directory.

## Configuration

All configuration is in `~/.chimera/config.json`. Chimera reads it at start,
so restart a session after a change.

| Key | Default | Purpose |
| --- | --- | --- |
| `providers` | — | Your model providers. [`PROVIDERS.md`](PROVIDERS.md) |
| `defaultModel` | — | The model of a new session (`provider/model`). |
| `models` | — | Options for each model: context window, profile, settings. [`PROVIDERS.md`](PROVIDERS.md#per-model-overrides) |
| `utilityModel` | session model | Low-cost model for helper work. [Subagents](SUBAGENTS.md#a-cheaper-model-for-helper-work) |
| `fallbackModel` | none | Second model when the first stays unavailable. |
| `defaultVisionModel` | none | Model for turns with images. [Model settings](docs/model-settings.md#image-input-and-vision-routing) |
| `responseTimeoutMs` | `120000` | How long the model can be silent. `0` turns the timeout off. |
| `defaultMode`, `cycleModes` | `build`, all modes | The first mode, and the modes that `Shift+Tab` cycles. |
| `commandPolicy.hostBash` | see docs | Command policy and OS sandbox: `mode`, `autoAllowThrough`, `osSandbox`, `network`, `sandboxWritePaths`. [Policy](docs/bash-command-policy.md) |
| `approvalReviewer.enabled` | `false` | A model examines approval requests first. |
| `goal.maxContinuations` | `20` | Continuations of one run for a goal that is not met. |
| `compaction` | on | `enabled`, `thresholdPercent`, `reserveTokens`, `keepRecentTokens`, `model`. [Compaction](docs/COMPACTION.md) |
| `recall` | on | Archive for large tool outputs: `enabled`, `archiveThresholdTokens`, `ttlDays`. |
| `memory.enabled` | `true` | Project memory. |
| `diagnostics` | auto-detect | Checks that run after each edit. [Tools](docs/tools.md#post-edit-diagnostics) |
| `webSearch` | none | Search provider for `web_search`: `searxng`, `tavily` or `brave`. |
| `workspaceCheckpoints` | `true` | Working tree snapshots for `/rewind`. |
| `mcpServers` | — | MCP servers; `chimera mcp` writes this. |
| `skills`, `commands`, `agents`, `modes` | on | Each has `enabled` and `claudeCompat`. |
| `tui` | — | `layout` (`fullscreen` or `inline`), `mouse`, `notifications` (`auto`, `bell`, `off`). |
| `statusLine` | model, context, cwd, branch; session, sandbox | `rows` of built-in items, or a `command`. [The TUI](docs/tui.md#status-line) |

A value of the form `env:NAME` in an API key is read from the environment.

## Commands

| Command | Purpose |
| --- | --- |
| `chimera` | Start the TUI. `--resume [id]`, `-c`, `--mode`, `-m`, `--inline`, `--sandbox`. |
| `chimera run <prompt>` | Run one prompt without the TUI. `--json`, `--stdin`, `--goal`, `--command`. |
| `chimera resume [id]`, `chimera continue` (`c`) | Resume a saved session. |
| `chimera sessions list\|rm\|review-bash` | Manage saved sessions. |
| `chimera serve` | Start only the server. |
| `chimera ls` | List the running instances. |
| `chimera attach <target>` | Open the TUI on a running instance. |
| `chimera mcp add\|list\|remove\|tools\|call\|login\|logout` | Manage MCP servers. |
| `chimera skills`, `commands`, `agents` | List what Chimera found in this directory. |
| `chimera hooks list` | List the hooks. |
| `chimera sandbox build` | Build the Docker sandbox image. |
| `chimera version` | Print the version (`dev` for a build from source); `--json` gives `{"version", "release"}`. |
| `chimera update` | Install the newest release; `--check`, `--version <tag>`, `--json`. [Install](docs/install.md#updating) |

`chimera <command> --help` shows each flag.

## Documentation

| Topic | Page |
| --- | --- |
| Install, update, uninstall | [docs/install.md](docs/install.md) |
| Keys, commands, layouts, notifications, themes | [docs/tui.md](docs/tui.md) |
| Sessions, resume, fork, rewind, files on disk | [docs/sessions.md](docs/sessions.md) |
| One-shot runs, the server, the HTTP API | [docs/headless.md](docs/headless.md) |
| Providers, model profiles, prompt caching, retries | [PROVIDERS.md](PROVIDERS.md) |
| Thinking, effort, vision | [docs/model-settings.md](docs/model-settings.md) |
| Tools, guards, diagnostics, background processes, web | [docs/tools.md](docs/tools.md) |
| OS sandbox, Docker sandbox | [docs/sandbox.md](docs/sandbox.md) |
| Command policy, sudo, approval reviewer, audit | [docs/bash-command-policy.md](docs/bash-command-policy.md) |
| Threat model | [SECURITY.md](SECURITY.md) |
| Instructions, project memory, task list | [docs/context.md](docs/context.md) |
| Compaction | [docs/COMPACTION.md](docs/COMPACTION.md) |
| Goals | [docs/goals.md](docs/goals.md) |
| Questions and handoffs to the user | [docs/request-user-input.md](docs/request-user-input.md) |
| Subagents, `explore`, background agents | [SUBAGENTS.md](SUBAGENTS.md) |
| Modes | [docs/MODES.md](docs/MODES.md) |
| Skills | [SKILLS.md](SKILLS.md) |
| User commands | [docs/COMMANDS.md](docs/COMMANDS.md) |
| MCP | [docs/mcp.md](docs/mcp.md) |
| Hooks | [docs/hooks.md](docs/hooks.md) |
| Evals with local models | [docs/evals.md](docs/evals.md) |

## Development

```bash
pnpm -r build                          # build every package
pnpm -r test                           # run every test suite
pnpm --filter @chimera/<pkg> test      # one package
pnpm biome:lint                        # lint
```

Packages use each other's built `dist/`, so build a package before you test
one that depends on it. [`AGENTS.md`](AGENTS.md) has the notes for
contributors and for agents that work on this repository.

```
packages/core          agent loop, events, sessions, prompts, goals
packages/providers     provider factories, model profiles, context windows
packages/tools         the built-in tools, guards, executors, OS sandbox
packages/permissions   command policy, permission gate, approval reviewer, audit
packages/hooks         lifecycle hook discovery and execution
packages/sandbox       Docker executor, overlay diff and apply
packages/compaction    context compaction
packages/recall        archive for large tool outputs
packages/modes         mode discovery and the built-in modes
packages/skills        skill discovery and index
packages/commands      user command discovery and expansion
packages/subagents     spawn_agent, agent definitions, background agents
packages/server        HTTP and SSE server
packages/client        typed client (ChimeraClient)
packages/tui           the terminal UI
packages/cli           the chimera binary, configuration, MCP
```

The dependencies have one direction: `cli` depends on the other packages, and
`core` depends on none of them.

## Limits

- The HTTP server has no authentication. It binds `127.0.0.1` by default.
- MCP: tools only. No resources, prompts, legacy SSE transport or manual
  bearer tokens.
- The OS sandbox limits writes and, on request, the network. It does not
  limit reads. It is not available on Windows.
- A one-shot run cannot show an approval prompt. See
  [Headless use](docs/headless.md#approvals-in-a-one-shot-run).
- Two clients that write to one session at the same time are not coordinated.
