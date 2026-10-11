## ADDED Requirements

### Requirement: Generated tools section
The system prompt SHALL contain a tools section generated from the tools registered for the session after the mode allowlist is applied. It SHALL list every such tool by name with a one-line description and SHALL NOT name a tool that is not registered.

#### Scenario: Plan mode
- **WHEN** a session runs in a mode whose allowlist is `read`, `glob`, `grep`, `task_list`
- **THEN** the tools section lists those tools and does not mention `bash` or `edit`

#### Scenario: Optional tool present
- **WHEN** a web search backend is configured
- **THEN** the tools section lists `web_search`

### Requirement: Prompt styles
The system prompt SHALL follow the model profile's `promptStyle`. `guided` SHALL add a working-method section with explicit tool-use rules. `lean` SHALL omit it.

#### Scenario: Guided model
- **WHEN** the session model resolves to `promptStyle: "guided"`
- **THEN** the system prompt contains the working-method section

#### Scenario: Lean model
- **WHEN** the session model resolves to `promptStyle: "lean"`
- **THEN** the system prompt does not contain the working-method section

### Requirement: Profile follows the active model
When the user changes the session model, the next run SHALL use the tool names, edit format and prompt style of the new model's profile.

#### Scenario: Switch to a patch model
- **WHEN** a session on a `replace` model switches to a model whose profile has `editFormat: "patch"`
- **THEN** the next run registers `apply_patch` and not `edit`, and the tools section says so
