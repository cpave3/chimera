## ADDED Requirements

### Requirement: Tool-call repair
Before a tool call fails validation, the agent SHALL try to repair it without a model call: map a wrongly cased, prefixed or aliased tool name to a registered tool, strip a code fence around the arguments, unwrap arguments sent as a JSON string, convert string booleans and numeric strings to the type the tool schema requires, and drop `null` values for optional properties. A call that is still invalid SHALL reach the model as a tool error.

#### Scenario: Boolean sent as a string
- **WHEN** the model calls a tool with `"true"` for a boolean argument
- **THEN** the tool runs with the boolean `true`

#### Scenario: Arguments sent as a JSON string
- **WHEN** the model sends the arguments object encoded as a JSON string
- **THEN** the tool runs with the decoded object

#### Scenario: Wrongly cased tool name
- **WHEN** the model calls `Bash` and a tool named `bash` is registered
- **THEN** the `bash` tool runs

#### Scenario: Not repairable
- **WHEN** the model omits a required argument
- **THEN** the model receives a tool error that names the argument
