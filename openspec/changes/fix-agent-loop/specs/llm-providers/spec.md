## ADDED Requirements

### Requirement: Prompt cache markers
A provider with `shape: "anthropic"` SHALL mark the last system message and the last message of every request with an ephemeral cache breakpoint, unless the provider is configured with `promptCaching: false`. Providers with `shape: "openai"` SHALL NOT add cache markers.

#### Scenario: Anthropic-shape request
- **WHEN** a model from an Anthropic-shape provider is called with a system prompt and messages
- **THEN** the request body has `cache_control` on the last system block and on the last content block of the last message

#### Scenario: Caching turned off
- **WHEN** the provider is configured with `promptCaching: false`
- **THEN** the request body has no `cache_control` field

#### Scenario: OpenAI-shape request
- **WHEN** a model from an OpenAI-shape provider is called
- **THEN** the request body has no cache marker
