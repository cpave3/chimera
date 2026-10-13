# Tools

This page lists the tools that the agent has, and the rules that apply to
each tool call.

## Built-in tools

| Tool | Purpose | Registered |
| --- | --- | --- |
| `bash` | Run a shell command: builds, tests, git. Also starts background processes. | Always |
| `read` | Read a file with line numbers, list a directory, or view an image. | Always |
| `write` | Create a file or replace its whole content. | Always |
| `edit` | Replace an exact string in a file. | For models that edit with replacements |
| `apply_patch` | Add, update, delete or move files with a patch. | For models that edit with patches (GPT, Codex) |
| `glob` | Find files by name pattern. | Always |
| `grep` | Search file contents with a regular expression. | Always |
| `fetch` | Fetch a URL as readable text. | Always |
| `web_search` | Search the web. | When `webSearch` is configured |
| `task_list` | Keep the task list for work with three or more steps. | Always |
| `recall` | Read an archived tool result by its id. | Unless `recall.enabled` is `false` |
| `ask_question` | Ask the user multiple-choice questions and continue with the answers. | Always; it waits only when a user can answer |
| `request_user_input` | End the run with a request for the user. | Always |
| `bash_output`, `bash_kill` | Read and stop a background process. | Always |
| `spawn_agent` | Give a task to a subagent. | Unless `--no-subagents`, and below the depth limit |
| `agent_status`, `agent_stop` | Look after background subagents. | With `spawn_agent`, in interactive and server sessions |
| `tool_search` | Find MCP tools that were held back. | When the MCP tool schemas are too large for the context |
| `mcp_<server>_<tool>` | The tools of your MCP servers. | For each configured server |

Notes:

- **Tool names follow the model.** For a model with the `codex` tool shape,
  `glob` is named `find`, an `ls` tool is added, and `bash` takes its timeout
  in seconds. The capabilities are the same. See
  [model profiles](../PROVIDERS.md#model-profiles).
- **Where the file tools work.** `read`, `write`, `edit` and `apply_patch`
  work in the working directory and the temp directory. `--add-read-path`,
  `--add-write-path`, `/add-read-path` and `/add-write-path` grant more.
  Outside these paths the agent uses `bash`, which the
  [command policy](bash-command-policy.md) and the
  [OS sandbox](sandbox.md) control.
- **A mode can limit the tools.** Plan mode has no tool that changes files.
  See [Modes](MODES.md).
- **Hooks see every call.** A `PreToolUse` hook can block a tool call. See
  [Lifecycle hooks](hooks.md).
- **Questions and handoffs.** `ask_question` and `request_user_input` are
  described in [Requesting user input](request-user-input.md).
- **Subagents.** `spawn_agent` is described in [Subagents](../SUBAGENTS.md).

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

## OS sandbox bypass

With the OS sandbox active, `bash` accepts `unsandboxed: true` with a `reason`
to request execution outside it. Generic auto-approval does not grant this.
An explicit exact/prefix allow rule with `allowUnsandboxed: true` can remember
the bypass for a session, project or globally; deny rules and other mandatory
policy findings still apply. Prefixes cover only a single simple literal
command, not compounds, substitutions, redirects, wrappers or environment
assignments. Trust the executable's subcommands before granting a prefix.
See [Remembered sandbox bypass](bash-command-policy.md#remembered-sandbox-bypass).

After building a tool-surface fix (including the Codex-shaped `bash` schema),
restart Chimera and start a new session to receive the updated tool definitions.
Rebuilding alone does not replace the schemas in an already running session.

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
