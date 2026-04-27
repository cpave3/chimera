# cli Specification

## Purpose

The `@chimera/cli` package exposes the `chimera` binary, which is the user entry point. It supports interactive (TUI), one-shot (`run`), server-only (`serve`), and attach modes; defines common flags, exit-code semantics, config-file loading, and instance lockfile management.

## Requirements

### Requirement: Entry-point subcommands

The `chimera` binary exported by `@chimera/cli` SHALL support:

- `chimera` (no args) — spawns server + TUI in one process; interactive session.
- `chimera run "<prompt>"` — one-shot: spawns server, runs prompt non-interactively, streams result to stdout, then exits.
- `chimera run --stdin` — reads the prompt from stdin.
- `chimera serve` — starts only the server; prints URL and instance ID; stays alive until signaled.
- `chimera attach <id|url>` — starts only the TUI, connects to an existing server (identified by instance ID from `chimera ls` or a direct URL).
- `chimera ls` — lists running instances by scanning `~/.chimera/instances/`.
- `chimera sessions` — lists persisted sessions under `~/.chimera/sessions/`.
- `chimera sessions rm <id>` — deletes a persisted session file.

Unknown subcommands SHALL exit with a non-zero code and a "did you mean…" suggestion when a close match exists.

#### Scenario: `chimera run` completes non-interactively

- **WHEN** a user runs `chimera run "echo hello"` against a stub provider that returns a bash tool call for `echo hello` and then a stop message
- **THEN** the process SHALL exit with status 0, stdout SHALL contain the assistant's final text, and the process SHALL NOT present any TUI

### Requirement: Exit codes for `chimera run`

`chimera run` SHALL map the terminal `run_finished.reason` to exit codes:

- `"stop"` → 0
- `"error"` → 1
- `"max_steps"` → 2
- `"interrupted"` (SIGINT or internal interrupt) → 130

#### Scenario: Max-steps exit

- **WHEN** a `chimera run` invocation ends with `run_finished.reason === "max_steps"`
- **THEN** the process SHALL exit with status 2

### Requirement: Common flags

The CLI SHALL accept these flags (MVP-scoped subset of `spec.md` §15.1):

- `-m, --model <providerId/modelId>` — override default model.
- `--cwd <path>` — working directory (default `process.cwd()`).
- `--max-steps <n>` — agent loop cap.
- `--session <id>` — resume a persisted session.
- `--auto-approve none|sandbox|host|all` — auto-approve level.
- `--json` — (run mode) emit NDJSON of `AgentEvent`s to stdout instead of rendered text.
- `--verbose` / `-v`, `--quiet` / `-q` — logging verbosity.

`chimera serve` additionally SHALL accept:

- `--port <n>` — override ephemeral port.
- `--host <addr>` — override bind address (default `127.0.0.1`; other values trigger a loud stderr warning).
- `--machine-handshake` — emit a single JSON line `{"ready":true,"url":"…","sessionId":"…","pid":…}` to stdout on ready (reserved for future subagent spawn — no in-tree caller in MVP but MUST be implemented).
- `--parent <sessionId>` — metadata only; included in the `/v1/instance` response's `parentId` field.

Sandbox flags (`--sandbox`, `--sandbox-mode`, etc.) and subagent flags (`--max-subagent-depth`, `--no-subagents`) SHALL NOT be accepted in MVP; passing them SHALL exit non-zero with a message explaining they are not yet supported.

#### Scenario: `--json` emits NDJSON

- **WHEN** a user runs `chimera run "hi" --json` against a stub provider
- **THEN** stdout SHALL contain exactly one JSON object per line, each a valid `AgentEvent`, and SHALL NOT contain any other text

#### Scenario: Sandbox flag rejected in MVP

- **WHEN** a user passes `--sandbox` to any subcommand
- **THEN** the CLI SHALL exit with status 1 and stderr SHALL name the flag and state that sandbox support is not yet available

### Requirement: Config file loading

The CLI SHALL load configuration from `~/.chimera/config.json` on startup if the file exists. Environment variables and flags SHALL override config values in that order (flags > env > file). The config schema in MVP SHALL include at minimum: `defaultModel`, `providers`, `autoApprove`. Fields for sandbox / skills / commands / subagents are reserved but SHALL be ignored (not rejected) if present, to ease forward-compatibility.

#### Scenario: CLI flag overrides config default

- **WHEN** the config has `defaultModel: "anthropic/claude-opus-4-7"` and the user runs `chimera run "hi" -m openrouter/some-model`
- **THEN** the effective model SHALL be `openrouter/some-model`

### Requirement: Instance lockfiles

On server start, the CLI SHALL write `~/.chimera/instances/<pid>.json` containing `{ pid, port, cwd, sessionId, startedAt, version }`. On clean shutdown (SIGINT/SIGTERM handled), it SHALL delete the lockfile. `chimera ls` SHALL scan that directory, filter out lockfiles whose `pid` no longer corresponds to a running process, and print the surviving instances in a stable tabular form.

Stale lockfiles encountered by `chimera ls` SHALL be deleted as a side effect.

#### Scenario: Stale lockfile cleanup

- **WHEN** `chimera ls` runs with two lockfiles present, one belonging to a live PID and one whose PID no longer exists
- **THEN** only the live instance SHALL appear in the output and the stale lockfile SHALL no longer exist on disk

### Requirement: `chimera hooks list` subcommand

The CLI SHALL accept a `chimera hooks list` subcommand that, without starting a server or session, scans the two well-known hook directories and prints the discovered hooks in a stable tabular form.

The directories scanned SHALL be:

1. `~/.chimera/hooks/<EventName>/`
2. `<--cwd>/.chimera/hooks/<EventName>/` (defaulting to `process.cwd()` when `--cwd` is not passed)

For each event directory, the command SHALL list every executable file (regular file or symlink to a regular file with at least one execute bit set), grouped by event name and labelled with its scope (`global` or `project`). Non-executable files, directories, and broken symlinks SHALL be omitted.

The output SHALL include all events defined by the `lifecycle-hooks` spec, even those with no installed hooks (printed with an empty list under the heading) so that users can confirm an event name is recognized.

`chimera hooks list --json` SHALL emit a single JSON object on stdout of shape `{ events: { <EventName>: { global: string[], project: string[] } } }` and no other text. Paths SHALL be absolute.

The subcommand SHALL exit 0 if it ran to completion, regardless of whether any hooks were found. It SHALL exit 1 only on internal errors (e.g., permission denied reading a directory the user explicitly owns).

#### Scenario: Lists discovered project hook

- **WHEN** `<cwd>/.chimera/hooks/PostToolUse/audit.sh` exists with mode 0755 and the user runs `chimera hooks list`
- **THEN** stdout SHALL include a `PostToolUse` section listing the absolute path of `audit.sh` under the `project` scope, and the exit code SHALL be 0

#### Scenario: Empty event listed

- **WHEN** the user runs `chimera hooks list` and no hooks are installed for `Stop` in either directory
- **THEN** the output SHALL still include a `Stop` section with an empty list, confirming the event name is recognized

#### Scenario: JSON output

- **WHEN** the user runs `chimera hooks list --json`
- **THEN** stdout SHALL contain exactly one JSON object whose top-level key is `events` and whose value is a map from each event name in `lifecycle-hooks` to `{ global: string[], project: string[] }`, and stdout SHALL contain no other text
