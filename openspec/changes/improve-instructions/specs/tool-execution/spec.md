## ADDED Requirements

### Requirement: Nested instruction files
When a `read`, `edit`, `write` or `apply_patch` call succeeds on a file in a directory below the working directory, and that directory or one between it and the working directory has an instruction file that this session has not sent yet, the tool result SHALL carry that file's content, outermost directory first. Each instruction file SHALL be sent at most once in a session. The working directory's own instruction files are in the system prompt and SHALL NOT be sent this way. The system prompt SHALL NOT change.

#### Scenario: First touch
- **WHEN** the model reads `packages/api/src/server.ts` and `packages/api/AGENTS.md` exists
- **THEN** the result has `instructions` with the path and content of `packages/api/AGENTS.md`

#### Scenario: Second touch
- **WHEN** the model then reads `packages/api/src/routes.ts`
- **THEN** the result has no `instructions`

#### Scenario: Two levels
- **WHEN** the model edits `packages/api/src/db/query.ts`, and both `packages/AGENTS.md` and `packages/api/src/db/CLAUDE.md` exist
- **THEN** the result has both files, `packages/AGENTS.md` first

#### Scenario: Failed call
- **WHEN** a `read` of a file in `packages/api` fails
- **THEN** the result has no `instructions`, and the next successful call there carries the file

### Requirement: Tool limits from the active mode
A mode file MAY limit a tool by writing `name(value, …)` in its `tools` list. The tool SHALL then be registered, and SHALL refuse a call outside the limit with an error that names the mode and the limit. `spawn_agent` SHALL accept a limit of agent names: under it, a call SHALL name one of those agents and SHALL NOT pass `tools` or `system_prompt`. A limit on a tool that has none SHALL give a warning when the mode loads.

#### Scenario: Allowed agent
- **WHEN** the mode has `spawn_agent(explore)` and the model calls `spawn_agent` with `agent: "explore"`
- **THEN** the child starts

#### Scenario: Other agent
- **WHEN** the mode has `spawn_agent(explore)` and the model calls `spawn_agent` with no `agent`
- **THEN** the tool returns an error that names the mode and `explore`, and no child starts

#### Scenario: Override under a limit
- **WHEN** the mode has `spawn_agent(explore)` and the model calls `spawn_agent` with `agent: "explore"` and `tools: ["bash"]`
- **THEN** the tool returns an error, and no child starts

### Requirement: Plan mode research tools
The built-in plan mode SHALL register `fetch`, `web_search`, `spawn_agent` limited to `explore`, `agent_status` and `agent_stop`, beside its read tools. It SHALL NOT register `bash`.

#### Scenario: Plan mode tools
- **WHEN** a session is in the built-in plan mode with web search configured
- **THEN** its tools are `read`, `glob`, `grep`, `task_list`, `fetch`, `web_search`, `spawn_agent`, `agent_status` and `agent_stop`, and the handoff tool that every mode has
