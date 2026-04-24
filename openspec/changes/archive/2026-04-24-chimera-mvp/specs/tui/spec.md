## ADDED Requirements

### Requirement: Ink-based interactive UI

`@chimera/tui` SHALL be an Ink (React for terminals) app that consumes `ChimeraClient` exclusively and makes no HTTP calls of its own outside that client. The app SHALL subscribe to the session's SSE event stream and derive all displayed state from `AgentEvent`s.

The TUI SHALL respect the `NO_COLOR` environment variable by omitting all ANSI color codes when it is set.

#### Scenario: NO_COLOR disables coloring

- **WHEN** the TUI is rendered with `NO_COLOR=1` set
- **THEN** the output SHALL contain no ANSI SGR sequences

### Requirement: Screen layout

The main screen SHALL show:

- A header line with: `Chimera · <short-id> · <cwd> · <model> · [sandbox:<mode>]`. In MVP `<mode>` is always `off`.
- A scrollable message region containing the assistant's streamed text, user messages, tool-call summaries (collapsible, badged `[sandbox]` or `[host]`), bash results (~20 lines visible, expandable), and errors (prominent red).
- An input box at the bottom with the prompt `>`.
- A footer with keybinding hints: `Ctrl+C interrupt · Ctrl+D exit · / commands`.

#### Scenario: Tool call badge reflects target

- **WHEN** the agent emits a `tool_call_start` event for `bash` with `target: "host"`
- **THEN** the tool call row SHALL display a `[host]` badge, not `[sandbox]`

### Requirement: Keybindings

The TUI SHALL honor:

- `Enter` — submit the current input.
- `Shift+Enter` — insert a newline into the input (multiline composition).
- `Ctrl+C` — if a run is in progress, call `client.interrupt(sessionId)`; a second `Ctrl+C` within 2 seconds SHALL exit the process.
- `Ctrl+D` — exit the process cleanly.
- `Up` / `Down` when the input is empty — navigate input history (persisted per-session in memory for MVP).
- `PgUp` / `PgDn` — scroll the scrollback region.
- `Tab` on partial `/` input — autocomplete built-in slash command names.

#### Scenario: Double Ctrl+C exits

- **WHEN** a user presses `Ctrl+C` while no run is active and then presses `Ctrl+C` again within 2 seconds
- **THEN** the process SHALL exit cleanly (zero status for a normal exit, 130 if propagating SIGINT)

### Requirement: Built-in slash commands

The TUI SHALL handle these slash commands internally, without sending them to the server or the model:

- `/help` — list all built-in slash commands with a one-line description each.
- `/clear` — clear the visible scrollback (does not clear session history on the server).
- `/new` — create a new session via `client.createSession` and switch to it; the previous session SHALL remain on the server and be listable via `/sessions`.
- `/sessions` — list the instance's sessions; selecting one switches the TUI's active session.
- `/exit` — equivalent to `Ctrl+D`.
- `/model` — show the active model; with an argument (e.g. `/model openrouter/claude-opus-4`) SHALL update the session's `ModelConfig` via the server.
- `/rules` — list active permission rules; `/rules rm <n>` removes the rule at index `n`.

Any `/<name>` not in the above list SHALL render an inline "unknown command; did you mean…" hint. (User-template slash commands are explicitly deferred to a later change.)

#### Scenario: Unknown slash command shows hint

- **WHEN** a user types `/halp` and presses Enter
- **THEN** the TUI SHALL render `unknown command: /halp — did you mean /help?` inline and SHALL NOT send any message to the server

### Requirement: Permission modal

When the event stream yields `permission_request`, the TUI SHALL render a modal overlay containing:

- A line identifying the target (`HOST` in MVP, since sandbox is off).
- The full command, monospaced.
- The `reason` (if present).
- Choices: `[a] Allow once`, `[A] Allow & remember this command`, `[g] Allow pattern…`, `[d] Deny once`, `[D] Deny & remember`, `[?] Show full command details`.

While the modal is active, the main input SHALL be inert; only modal-specific keybinds SHALL be honored. Choosing `[g]` SHALL open a sub-prompt prefilling the command so the user can edit it to a glob; a second sub-prompt SHALL ask `Remember for [s]ession or [p]roject?`.

After a selection, the TUI SHALL call `client.resolvePermission` (and, for `A`/`D`/`g`, `client.addRule` beforehand) and close the modal.

#### Scenario: Allow-and-remember with session scope

- **WHEN** a user presses `A` in the modal and then `s` in the scope prompt for a `bash` call `pnpm run test`
- **THEN** the TUI SHALL first POST a new session-scope exact rule `{ tool: "bash", pattern: "pnpm run test", patternKind: "exact", decision: "allow" }` and then POST the permission resolution with `decision: "allow"`, `remember: { scope: "session" }`
