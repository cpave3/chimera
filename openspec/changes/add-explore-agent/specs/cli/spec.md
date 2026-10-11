## ADDED Requirements

### Requirement: Utility model setting
`config.json` SHALL accept `utilityModel` as a `<providerId>/<modelId>` reference. Compaction SHALL use it when `compaction.model` is not set. When the reference cannot be resolved, the CLI SHALL warn once and SHALL use the session model for helper work.

#### Scenario: Compaction fallback
- **WHEN** `utilityModel` is set and `compaction.model` is not
- **THEN** compaction summaries run on the utility model

#### Scenario: Compaction model wins
- **WHEN** both `utilityModel` and `compaction.model` are set
- **THEN** compaction summaries run on `compaction.model`

### Requirement: Explore guidance in the prompt
When `spawn_agent` is registered and an `explore` definition exists, the system prompt's tool list SHALL tell the model to give a wide search to `explore` and to search directly when it knows where to look.

#### Scenario: Guidance present
- **WHEN** a session starts with subagents enabled
- **THEN** the system prompt names `explore` in the `spawn_agent` line
