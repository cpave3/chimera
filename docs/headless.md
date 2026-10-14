# Headless use

Chimera runs without the TUI in two ways: `chimera run` for one prompt, and
`chimera serve` for a server that other clients drive. Both use the same
agent, tools and configuration as the TUI.

## One prompt: `chimera run`

```
chimera run "run the test suite and fix the failures"
chimera run --json "list the top-level files" > events.ndjson
git diff | chimera run --stdin
chimera run --command review --args "src/auth.ts"
chimera run --goal "pnpm test passes" "fix the failing tests"
```

- **Output.** The assistant text goes to stdout. Tool calls and goal results
  go to stderr, one line each. With `--json`, each event is one JSON object
  on stdout and nothing else is printed. See
  [an example transcript](session-transcript.md).
- **Prompt sources.** The arguments, `--stdin`, or a user command template
  with `--command <name>` and `--args`. See [User commands](COMMANDS.md).
- **Session.** `--session <id>` continues a saved session. `--session-name`
  and `--session-id` name a new one, and `--session-exists resume|new|error`
  says what to do when the id is in use.
- **Goal.** `--goal` sets a completion condition for the run. See
  [Goals](goals.md).
- The model, mode, sandbox, path and subagent flags are the same as for the
  interactive command. `chimera run --help` lists them.

### Approvals in a one-shot run

`chimera run` has no prompt. The default `--auto-approve host` runs host
commands that the [command policy](bash-command-policy.md) accepts.

- A command that the policy sends to the user (for example a `danger`
  finding, or an unsandboxed request) **waits** until a client answers the
  request through the HTTP API. A plain terminal has no such client, so the
  run does not continue. Use rules, the OS sandbox, the
  [approval reviewer](bash-command-policy.md#approval-reviewer) or the
  [System One check](bash-command-policy.md#system-one-check) to prevent
  this, or drive the run from a client that answers.
- An MCP call needs a `trustedTools` entry or an allow rule. Without one it is
  denied. See [MCP tools](mcp.md).
- The agent cannot ask questions: `ask_question` returns at once, and the
  agent states its assumption. `request_user_input` ends the run with a
  machine-readable request. See [Requesting user input](request-user-input.md).

### Exit codes

| Reason the run ended | Code |
| --- | --- |
| `stop`, `waiting_for_input` | 0 |
| `error`, `timeout` | 1 |
| `max_steps`, `output_limit` | 2 |
| `interrupted` | 130 |

With `--goal` the code also says how the goal ended:

| Goal | Code |
| --- | --- |
| Met | 0 |
| The check failed | 1 |
| Not met at the continuation limit | 2 |
| Not possible | 3 |

## A server: `chimera serve`

```
chimera serve                       # start the server; the port is chosen by the system
chimera serve --port 4141           # a fixed port
chimera ls                          # the running instances on this machine
chimera attach <target>             # open the TUI on a running instance
```

- The server binds `127.0.0.1` by default (`--host` changes that). **There is
  no authentication.** Do not bind an address that other machines can reach.
- `--machine-handshake` prints one JSON line when the server is ready, for a
  program that starts it.
- Each interactive `chimera` is also a server. `chimera ls` lists every
  instance that answers, and `chimera attach` opens a second TUI on one of
  them. The target is a pid, the start of a session id, or a URL.
- Subagents are `chimera serve` child processes, so you can attach to them
  too. See [Subagents](../SUBAGENTS.md).

## The HTTP API and the SDK

The TUI, `chimera run` and subagents all use the same interface: HTTP for
requests and Server-Sent Events for the event stream. `@chimera/client`
(`ChimeraClient`) is the typed TypeScript client for it.

| Route | Purpose |
| --- | --- |
| `GET /healthz`, `GET /v1/instance` | Liveness and instance facts |
| `POST /v1/sessions`, `GET /v1/sessions` | Create and list sessions |
| `GET`, `DELETE /v1/sessions/:id` | Snapshot of a session; delete it |
| `POST /v1/sessions/:id/messages` | Send a message and start or steer a run |
| `GET /v1/sessions/:id/events` | The event stream (SSE) |
| `POST /v1/sessions/:id/interrupt` | Stop the run |
| `POST /v1/sessions/:id/permissions/:requestId` | Answer an approval request |
| `GET`, `POST /v1/sessions/:id/permissions/rules`, `DELETE …/rules/:idx` | Permission rules |
| `POST /v1/sessions/:id/questions/:requestId` | Answer an `ask_question` call |
| `GET /v1/sessions/:id/status` | State (`idle`, `running`, …), mode, cwd and name |
| `GET`, `POST /v1/sessions/:id/mode`, `GET …/modes` | Mode |
| `GET`, `POST /v1/sessions/:id/model`, `GET …/models` | Model and its settings |
| `PUT /v1/sessions/:id/goal` | Set or clear the goal |
| `GET`, `POST /v1/sessions/:id/paths` | Granted read and write paths |
| `GET /v1/sessions/:id/context` | Token breakdown of the context |
| `POST /v1/sessions/:id/compact`, `POST …/reload` | Compact the context; compose the system prompt again |
| `POST /v1/sessions/:id/resume`, `POST …/fork`, `GET …/checkpoints`, `POST …/rewind` | Resume, fork and rewind |
| `GET /v1/sessions/:id/commands`, `…/skills`, `…/subagents` | What the session discovered |

Events that a client must handle to drive a session without the TUI:

| Event | The client must |
| --- | --- |
| `permission_request` | Answer with `POST …/permissions/:requestId`. A request that the approval reviewer escalated has a `reviewerReason`. A command that the System One check rejected has a `systemOneNote`. |
| `question_request` | Answer or cancel with `POST …/questions/:requestId`. |
| `user_input_required` | Show the request; the run has ended. |
| `run_finished` | Read `reason`; the run is over. |

Events that only report: `approval_reviewed` (the reviewer's decision),
`system_one_checked` (the System One check's verdict),
`goal_updated` (a goal change or check result), `task_list_updated`,
`usage_updated`, `subagent_spawned` and `subagent_finished`,
`background_process_exited`, and the tool and text events of
[the example transcript](session-transcript.md).

All event additions are optional fields or new event types. A client that
ignores unknown events continues to operate.
