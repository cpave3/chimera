## ADDED Requirements

### Requirement: Mode file format

A mode is a file `<root>/<name>.md` whose first block SHALL be YAML frontmatter delimited by `---` lines. The frontmatter SHALL include at minimum:

- `name`: string — MUST equal the filename (without `.md`).
- `description`: string — one sentence describing the mode.

The frontmatter MAY also include:

- `tools`: array of strings — tool-name allowlist. If absent, all registered tools are available; if present but empty (`[]`), no tools are registered; if listed, only the listed tool names are registered for turns in this mode.
- `model`: string — a `providerId/modelId` reference used as a soft default when the session has no sticky user override.

The body after the frontmatter is the mode's prompt fragment; it is used verbatim (no placeholder substitution) as appended system-prompt content when the mode is active.

A JSON Schema SHALL be published at `@chimera/modes/schema.json` describing the frontmatter shape so editors with YAML LSP can offer autocomplete and inline validation.

#### Scenario: Valid mode parsed

- **WHEN** `.chimera/modes/plan.md` exists with frontmatter `name: plan, description: "…", tools: [read]` and a body of prose
- **THEN** `loadModes` SHALL return a registry whose `find("plan")` returns `{ name: "plan", description: "…", body: <prose>, tools: ["read"], model: undefined, path: <absolute>, source: "project" }`

#### Scenario: Invalid frontmatter excluded

- **WHEN** `.chimera/modes/broken.md` has a YAML parse error or is missing `description`
- **THEN** `loadModes` SHALL omit `broken` from the registry and SHALL log exactly one warning line identifying the file and the failure reason

### Requirement: Discovery paths

`loadModes({ cwd, userHome, includeClaudeCompat })` SHALL search tiers in this priority order:

1. `<cwd>/.chimera/modes/<name>.md`
2. Ancestor walk from `cwd` toward the nearest `.git/` directory (or `userHome` if no git root is encountered): `<ancestor>/.chimera/modes/<name>.md`
3. `<userHome>/.chimera/modes/<name>.md`

When `includeClaudeCompat !== false`:

4. `<cwd>/.claude/modes/<name>.md`
5. Ancestor walk for `.claude/modes/<name>.md`
6. `<userHome>/.claude/modes/<name>.md`

Built-in modes SHALL be registered at an implicit seventh tier backed by files bundled inside `@chimera/modes/builtin/`. The only built-in shipped in this change is `plan.md`.

Name collisions SHALL resolve higher-tier-wins with one log warning per collision. `loadModes` SHALL NOT register a `normal` entry; "no mode active" is the sentinel for normal and cannot be overridden by a file.

#### Scenario: User override of a built-in

- **WHEN** the user has `~/.chimera/modes/plan.md` AND `@chimera/modes/builtin/plan.md` ships with the package
- **THEN** `registry.find("plan").source` SHALL equal `"user"` and its `path` SHALL be the user's copy; the built-in SHALL NOT appear in `registry.all()`

#### Scenario: `normal` is not a file

- **WHEN** `~/.chimera/modes/normal.md` exists on disk
- **THEN** `loadModes` SHALL exclude it with a warning identifying "normal" as a reserved name

### Requirement: Runtime validation

At session start, after tools and providers have been registered, each discovered mode SHALL be validated against:

1. **Schema** — frontmatter shape.
2. **Tool registry** — every name in `tools` exists in the currently registered tool set.
3. **Provider registry** — if `model` is set, the `providerId` prefix (everything before the first `/`) is present in the live `ProviderRegistry`.

Modes failing any tier SHALL be *excluded* from the registry returned for the session and SHALL produce exactly one warning log line per failure identifying the file, tier, and failing field.

Attempts to *use* an excluded mode (selecting it via `defaultMode`, `--mode`, `/mode`, Shift+Tab cycling, or `POST /v1/sessions/:id/mode`) SHALL error with the original validation reason and SHALL NOT silently fall back to a different mode.

An opt-in `chimera modes check --live` SHALL additionally probe each mode's `model` by making a zero-token request to the provider; any failure SHALL be reported in the command's output but SHALL NOT affect session start or runtime behavior.

#### Scenario: Unknown tool name excludes the mode

- **WHEN** `plan.md` lists `tools: [read, grpe]` and the registered tool set is `{read, write, bash, edit}`
- **THEN** the mode SHALL NOT appear in `registry.all()`, a warning SHALL be logged naming `grpe`, and `/mode plan` SHALL error with a message identifying the missing tool

#### Scenario: Provider-scoped model

- **WHEN** `plan.md` has `model: internal-proxy/claude-opus-4` and the user's provider registry does NOT contain `internal-proxy`
- **THEN** `plan` SHALL be excluded at discovery with a warning naming the missing provider; the effective model resolution for other modes SHALL be unaffected

### Requirement: Session state

`Session` SHALL gain two fields:

- `mode: string | undefined` — the currently active mode's name; `undefined` means normal.
- `userModelOverride: string | null` — the effective model the user explicitly requested via `-m` at launch or `/model <ref>` mid-session; `null` means no override is active.

Both fields SHALL be serialized in the session snapshot (`~/.chimera/sessions/<id>.json`). Sessions persisted before this change SHALL deserialize with both fields at their defaults and SHALL NOT error on missing fields.

`userModelOverride` SHALL persist across mode switches — it is cleared only by `/model default` / `/model reset`, by a new session, or by the consumer calling a dedicated SDK method.

#### Scenario: Resume into the previous mode

- **WHEN** a session with `mode: "plan"` and `userModelOverride: "openrouter/claude-opus-4"` is persisted, the process exits, and `chimera --session <id>` resumes it
- **THEN** the resumed session SHALL have `status: "idle"`, `mode: "plan"`, and `userModelOverride: "openrouter/claude-opus-4"`

### Requirement: System-prompt composition

While a mode is active, `composeSystemPrompt` SHALL append, after any `AGENTS.md` content and skill index block, a section consisting of:

- the literal line `# Current mode: <name>`,
- a blank line,
- the verbatim body of the active mode's file.

When `session.mode` is `undefined`, no such section SHALL be appended and the composed prompt SHALL be identical to the pre-modes MVP output.

On mode switch, the next call to `composeSystemPrompt` SHALL replace the entire trailing mode section (identifiable by its `# Current mode:` header) with the new mode's section. Historical messages SHALL NOT be rewritten.

#### Scenario: Normal sessions unchanged

- **WHEN** a session runs without ever setting a mode
- **THEN** its composed system prompt SHALL NOT contain the literal `# Current mode:` header

#### Scenario: Switch recomposes only the mode block

- **WHEN** a session has `mode: "plan"`, the user switches to a mode `review`, and the next agent step composes its system prompt
- **THEN** the new prompt SHALL contain exactly one `# Current mode: review` section, SHALL NOT contain a `# Current mode: plan` section, and the preceding role prompt / AGENTS.md / skill index sections SHALL be byte-identical to the previous step's

### Requirement: Tool allowlist enforcement

When a mode is active with a `tools` allowlist, the tool set passed to `streamText({ tools })` for that step SHALL include only tools whose names appear in the allowlist. When the allowlist is absent, all registered tools SHALL be passed. When the allowlist is `[]`, an empty object `{}` SHALL be passed (no tools registered).

If the allowlist references a tool name that is not currently registered (e.g. `spawn_agent` when `--no-subagents` is set), that name SHALL be silently dropped from the effective set at session start and SHALL produce a single warning log line.

#### Scenario: Plan mode sees only allowed tools

- **WHEN** the session's active mode has `tools: [read]` and the registered tools are `{read, write, bash, edit}`
- **THEN** the model's tool-use schema for that step SHALL contain exactly one tool definition (`read`), and tool-call dispatch SHALL NOT be reachable for any other name

#### Scenario: Pure-text mode

- **WHEN** the active mode has `tools: []`
- **THEN** the model SHALL receive no tool schema and any tool call in the model's output SHALL be treated as a model error surfaced via `tool_call_error` with an explanatory message

### Requirement: Effective model resolution

For each model call, the effective model SHALL be resolved as:

1. `Session.userModelOverride` if not `null`, else
2. The current mode's `model` field if the mode is active and has one, else
3. `config.defaultModel`.

If none of the above yields a value, the CLI SHALL have refused to start the session (per MVP's `llm-providers` spec "Default model selection" requirement); the runtime SHALL NOT reach this condition at a call site.

`mode_changed` events SHALL carry the computed `effectiveModel` and a boolean `effectiveModelChanged` indicating whether it differs from the previous active mode's effective model.

#### Scenario: Sticky override survives mode switch

- **WHEN** a session has `userModelOverride: "openrouter/opus"` and the user switches from normal to plan (where `plan.model` is `"openrouter/haiku"`)
- **THEN** the next step's effective model SHALL be `"openrouter/opus"` and the `mode_changed` event's `effectiveModelChanged` SHALL be `false`

#### Scenario: Mode.model wins when no sticky override

- **WHEN** a session has `userModelOverride: null`, `config.defaultModel: "anthropic/sonnet"`, and the user switches into a mode with `model: "openrouter/haiku"`
- **THEN** the next step's effective model SHALL be `"openrouter/haiku"` and the `mode_changed` event's `effectiveModelChanged` SHALL be `true`

### Requirement: Switching

Mode switches SHALL be requestable via:

- **TUI built-in**: `/mode` (shows current), `/mode <name>` (requests switch).
- **TUI keybind**: `Shift+Tab` — cycles forward through `cycleModes` (an ordered list from config; default `["normal", "plan"]`). Wraps. Unknown names in `cycleModes` warn and are skipped. No reverse keybind in V1.
- **CLI launch flag**: `--mode <name>` sets the initial mode for a new session.
- **Config**: `defaultMode: string` in `~/.chimera/config.json` or project config; overridden by `--mode`.
- **SDK / HTTP**: `POST /v1/sessions/:id/mode` with body `{ mode: string }`; client method `setMode(sessionId, name)`.

All in-session switches (anything after session creation) SHALL be **queued** when a run is active — they are applied at the top of the next run, not mid-turn. While queued, the TUI header SHALL render `[mode:<current> → <queued>]`. A second queued switch overwrites the first (last-writer-wins, single slot).

Switching to a name that is not in the mode registry (unknown or excluded by validation) SHALL error before the switch is queued; the session's mode SHALL remain unchanged.

#### Scenario: Queued switch applies after the current turn

- **WHEN** a run is active with `mode: "normal"`, the user sends `/mode plan` mid-run, the run completes, and the next user message is sent
- **THEN** the previous run's events SHALL include no `mode_changed`; a `mode_changed { from: "normal", to: "plan", reason: "user" }` event SHALL fire before the next run's first step; and that next step's system prompt SHALL include the plan mode block

#### Scenario: Shift+Tab cycling

- **WHEN** the session's current mode is `normal`, `cycleModes` is `["normal", "plan", "review"]`, and the user presses Shift+Tab three times between turns
- **THEN** after processing all three keypresses the active mode SHALL be `normal` again (normal → plan → review → normal)

#### Scenario: Rejected switch to excluded mode

- **WHEN** `/mode broken` is invoked on a session where `broken` was excluded at discovery due to a missing provider
- **THEN** the TUI SHALL render an inline error naming the reason, NO switch SHALL be queued, and NO `mode_changed` SHALL fire

### Requirement: `mode_changed` event

Every effective mode change on a session SHALL emit exactly one `mode_changed` event on the session event stream with shape:

```
{
  type: "mode_changed",
  from: string | null,         // previous mode name or null for normal
  to: string | null,           // new mode name or null for normal
  reason: "user" | "startup" | "command" | "subagent-inherit" | "resume",
  effectiveModel: string,
  effectiveModelChanged: boolean
}
```

The event SHALL fire *before* the first `streamText` call under the new mode, so consumers observe the switch before any downstream event carries the new mode's effects.

#### Scenario: Event ordering

- **WHEN** a mode switch lands between two runs
- **THEN** the event stream SHALL contain the previous run's `run_finished`, then `mode_changed`, then the next run's first event (typically `user_message`), in that order with no other events interleaved between `mode_changed` and the next `user_message`

### Requirement: Subagent mode parameter

`@chimera/subagents`'s `spawn_agent` tool SHALL accept an optional `mode?: string` argument. If omitted, the child Agent's initial `Session.mode` SHALL be `undefined` (normal) — the parent's mode SHALL NOT be inherited.

If the `mode` argument names a mode that does not exist in the child's mode registry (the child resolves its own six-tier search from its own `cwd`), the child SHALL fail to start and the tool call SHALL return a `reason: "error"` result naming the missing mode.

#### Scenario: Plan-parent spawning normal child

- **WHEN** a parent session in `mode: "plan"` invokes `spawn_agent { prompt: "…", purpose: "…" }` without specifying `mode`
- **THEN** the child session SHALL start with `mode: undefined` (normal) and its registered tool set SHALL NOT be restricted by plan's allowlist

#### Scenario: Explicit mode override on spawn

- **WHEN** the parent calls `spawn_agent { ..., mode: "plan" }` and the child's cwd discovery finds a `plan` mode
- **THEN** the child session SHALL start with `mode: "plan"` and fire `mode_changed { from: null, to: "plan", reason: "startup" }` as the first event on its stream

### Requirement: Command mode field

`@chimera/commands`'s command frontmatter SHALL accept an optional `mode: string` field. When a command with that field is invoked via the TUI or `chimera run --command`, the mode switch SHALL be queued via the same machinery as `/mode` *before* the expanded template is sent as a user message. The resulting `mode_changed` event SHALL carry `reason: "command"`.

If the named mode is absent or excluded, the command invocation SHALL error with the validation reason; the expanded message SHALL NOT be sent and no `mode_changed` SHALL fire.

The mode switch triggered by a command persists after the message — commands are not transient switches in V1.

#### Scenario: `/plan feature X`

- **WHEN** `.chimera/commands/plan.md` has `mode: plan` and body `Think carefully about: $ARGUMENTS` and a user types `/plan add authentication`
- **THEN** a `mode_changed { to: "plan", reason: "command" }` event SHALL fire, THEN the user message `"Think carefully about: add authentication"` SHALL be sent, and the active mode SHALL remain `plan` after the turn completes

### Requirement: TUI affordances

The TUI header specified in MVP SHALL gain a trailing badge `[mode:<name>]` when a mode is active. The badge SHALL be hidden when `session.mode` is `undefined` (normal). While a switch is queued, the badge SHALL render as `[mode:<current> → <queued>]`.

The TUI SHALL implement `/mode`, `/mode <name>`, and Shift+Tab per the Switching requirement, and SHALL render an inline separator line in the scrollback on every `mode_changed` event naming the `from` / `to` mode.

#### Scenario: Header renders queued switch

- **WHEN** a session in `mode: "normal"` receives a queued `/mode plan` while a run is in progress
- **THEN** the TUI header SHALL display `... · [mode:normal → plan]` until the run completes and the switch lands; afterwards the header SHALL display `... · [mode:plan]`

### Requirement: CLI surface

`@chimera/cli` SHALL:

- Accept `--mode <name>` on `chimera`, `chimera run`, and `chimera attach`. It sets the initial mode for new sessions; on `attach` it queues a switch on the attached session.
- Honor `defaultMode` in `~/.chimera/config.json` and project `.chimera/config.json`. `--mode` overrides it.
- Honor `cycleModes: string[]` in config (default `["normal", "plan"]` as shipped).
- Register `chimera modes` listing the session's loaded registry as a table (columns: name, source, path, tools, model, description); `--json` SHALL produce machine-readable output.
- Register `chimera modes check [--live] [--mode <name>]` running the four-tier validator; exit code 0 on success, 1 on any warning or error. `--live` enables the opt-in provider probe tier.

#### Scenario: Non-zero exit on broken mode

- **WHEN** a user runs `chimera modes check` in a project where a mode references a non-existent provider
- **THEN** the process SHALL exit with status 1, stderr SHALL name the mode and the missing provider, and stdout SHALL NOT contain the broken mode in its registry table

### Requirement: HTTP / SDK surface

`@chimera/server` SHALL expose:

- `POST /v1/sessions/:id/mode` with body `{ mode: string }` — queues a mode switch on the session. Respond `202` on accepted (whether the session is idle or running). Respond `404` if the mode name is not in the session's registry; include the validation reason in the error body.
- `GET /v1/sessions/:id/modes` — returns the session's bound mode registry as `Mode[]`.

`@chimera/client` SHALL implement `setMode(sessionId, name): Promise<void>` and `listModes(sessionId): Promise<Mode[]>`. `setMode` SHALL surface `404` as a typed `UnknownModeError` carrying the validation reason.

Both endpoints SHALL be subject to the same loopback-bind and (future) auth story as the rest of the server.

#### Scenario: Set mode via SDK matches TUI behavior

- **WHEN** a consumer calls `await client.setMode(sessionId, "plan")` while a run is in progress
- **THEN** the server SHALL respond `202`, the queued switch SHALL land at the top of the next run, and the SSE event stream SHALL yield a `mode_changed { reason: "user" }` event before the next run's first event

### Requirement: Built-in `plan` mode

The `@chimera/modes` package SHALL bundle a built-in `plan.md` at `@chimera/modes/builtin/plan.md` with:

- frontmatter: `name: plan`, `description: "Read-only planning mode. Build context and propose a plan before mutating anything."`, `tools: [read]`.
- a body directing the model to build context, produce a numbered plan, surface assumptions and options, and end with the literal line `Plan ready for review.`

The built-in SHALL be overridable by any higher-tier user or project mode of the same name, per the Discovery paths requirement.

#### Scenario: Unoverridden built-in

- **WHEN** a user runs `chimera` in a project with no `.chimera/modes/plan.md` anywhere on the discovery path and passes `--mode plan`
- **THEN** the session SHALL start in plan mode with `registry.find("plan").source === "builtin"`, tool registration SHALL contain only `read`, and the system prompt SHALL end with a `# Current mode: plan` section followed by the built-in body
