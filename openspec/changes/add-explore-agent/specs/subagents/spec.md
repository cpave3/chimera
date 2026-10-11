## ADDED Requirements

### Requirement: Built-in explore agent
Chimera SHALL ship an agent definition named `explore` that is available with no user setup. Its tools SHALL be `read`, `glob`, `grep`, `fetch` and `web_search`, and its instructions SHALL tell it to answer with findings that carry `path:line` references and to change nothing. A user or project definition with the same name SHALL take priority, and that shadowing SHALL NOT produce a warning.

#### Scenario: Available by default
- **WHEN** a session starts in a directory with no agent definitions
- **THEN** the `spawn_agent` tool description lists `explore`

#### Scenario: User definition wins
- **WHEN** `~/.chimera/agents/explore.md` exists
- **THEN** `spawn_agent` with `agent: "explore"` uses the user's definition, and no warning is shown

### Requirement: Utility model alias
An agent definition with `model: utility` SHALL run on the model named by the `utilityModel` config key. When that key is not set, it SHALL run on the parent's model with the parent's settings. A `model` argument on the call SHALL take priority over the definition.

#### Scenario: Key set
- **WHEN** `utilityModel` is `anthropic/claude-haiku-4-5` and the model calls `spawn_agent` with `agent: "explore"`
- **THEN** the child runs on `anthropic/claude-haiku-4-5`

#### Scenario: Key not set
- **WHEN** `utilityModel` is not set and the parent runs on `manticore/gpt`
- **THEN** the child runs on `manticore/gpt`

### Requirement: Background children
`spawn_agent` SHALL accept `background: true`. The call SHALL return as soon as the child has started, with the child's id and the state `running`. The child SHALL continue when the parent's run ends or is interrupted. When the child ends, Chimera SHALL add a message to the parent conversation that names the child, its purpose and its end state and holds its final answer; when the parent has no run in progress, that message SHALL start one. An in-process child SHALL NOT run in the background.

#### Scenario: Call returns at once
- **WHEN** the model calls `spawn_agent` with `background: true`
- **THEN** the tool result has `status: "running"` and a `subagent_id`, and the child is still running

#### Scenario: Result during a run
- **WHEN** a background child ends while the parent's run is in progress
- **THEN** the parent sees the child's answer as a message at its next step

#### Scenario: Result while idle
- **WHEN** a background child ends while the parent has no run in progress
- **THEN** a run starts with the child's answer as its message

#### Scenario: In-process
- **WHEN** the model calls `spawn_agent` with `background: true` and `in_process: true`
- **THEN** the tool returns an error and starts no child

### Requirement: Background child tools
While a session can start background children, it SHALL register `agent_status` and `agent_stop`. `agent_status` SHALL list the session's background children with id, purpose, state and running time, and SHALL include the final answer of a finished child when asked for one id. `agent_stop` SHALL stop one running child. When the session ends, Chimera SHALL stop every background child that is still running.

#### Scenario: Status
- **WHEN** one background child is running and one has finished
- **THEN** `agent_status` lists both with their states

#### Scenario: Stop
- **WHEN** the model calls `agent_stop` with the id of a running child
- **THEN** the child is stopped and its state is `stopped`

#### Scenario: Session end
- **WHEN** the session ends with a background child running
- **THEN** the child is stopped
