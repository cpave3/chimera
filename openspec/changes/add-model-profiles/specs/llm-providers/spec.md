## ADDED Requirements

### Requirement: Model profile resolution
The system SHALL resolve a profile for each model with the fields `toolCallShape`, `editFormat`, `promptStyle` and `outputBudgetTokens`. Explicit values under `models.<ref>` in the config SHALL win field by field. Otherwise a model id matching a GPT or Codex family SHALL get `editFormat: "patch"` and `promptStyle: "lean"`, a model id containing `claude` SHALL get `editFormat: "replace"` and `promptStyle: "lean"`, and every other model SHALL get `editFormat: "replace"` and `promptStyle: "guided"`. `toolCallShape` SHALL default to `chimera`. `outputBudgetTokens` SHALL be 8% of the context window, at least 2,000 and at most 25,000.

#### Scenario: Known GPT model
- **WHEN** the profile for `gpt-5-codex` is resolved with no config entry
- **THEN** `editFormat` is `patch` and `promptStyle` is `lean`

#### Scenario: Unknown model
- **WHEN** the profile for `qwen3-coder` is resolved with no config entry
- **THEN** `editFormat` is `replace` and `promptStyle` is `guided`

#### Scenario: Config override
- **WHEN** the config sets `promptStyle: "lean"` for an unknown model
- **THEN** the profile has `promptStyle: "lean"` and keeps the default `editFormat`

#### Scenario: Output budget bounds
- **WHEN** profiles are resolved for context windows of 16,000, 200,000 and 1,000,000 tokens
- **THEN** the output budgets are 2,000, 16,000 and 25,000 tokens
