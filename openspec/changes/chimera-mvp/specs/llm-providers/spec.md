## ADDED Requirements

### Requirement: Shape-based provider registry

`@chimera/providers` SHALL accept a `ProvidersConfig` object mapping a user-chosen `providerId` string to `{ shape: "openai" | "anthropic", baseUrl: string, apiKey: string }` and SHALL return a `ProviderRegistry` whose `get(providerId)` yields a `Provider` backed by `@ai-sdk/openai`'s `createOpenAI` or `@ai-sdk/anthropic`'s `createAnthropic` respectively.

The `providerId` key is user-defined (a local alias) and the registry MUST NOT hard-code any specific vendor names.

#### Scenario: OpenRouter configured as an OpenAI-shaped provider

- **WHEN** the config contains `providers.openrouter = { shape: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: "env:OPENROUTER_API_KEY" }` and `OPENROUTER_API_KEY` is set in the environment
- **THEN** `registry.get("openrouter").getModel("anthropic/claude-opus-4").doGenerate(...)` SHALL issue an HTTPS request to `https://openrouter.ai/api/v1/chat/completions` carrying `Authorization: Bearer <env value>`

#### Scenario: Anthropic configured as its native shape

- **WHEN** the config contains `providers.anthropic = { shape: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "env:ANTHROPIC_API_KEY" }`
- **THEN** `registry.get("anthropic").getModel("claude-opus-4-7")` SHALL return a `LanguageModel` constructed via `@ai-sdk/anthropic`'s `createAnthropic` factory using the same baseUrl and the environment-resolved key

### Requirement: `providerId/modelId` resolution

`ProviderRegistry.resolve(modelRef)` SHALL parse the string form `"<providerId>/<modelId>"` into `{ provider, modelId }` where `modelId` is everything after the first `/`. Model IDs containing additional slashes (e.g. `"openrouter/anthropic/claude-opus-4"`) SHALL split only on the first slash so that `"anthropic/claude-opus-4"` is preserved as a single `modelId` for the `openrouter` provider.

#### Scenario: Nested slash in model ID

- **WHEN** `registry.resolve("openrouter/anthropic/claude-opus-4")` is called against a config that defines the `openrouter` provider
- **THEN** it SHALL return `{ provider: openrouterProvider, modelId: "anthropic/claude-opus-4" }`

#### Scenario: Unknown providerId

- **WHEN** `registry.resolve("nonesuch/foo")` is called and no `nonesuch` provider is configured
- **THEN** the call SHALL throw an Error whose message names the unknown provider and lists the configured provider IDs

### Requirement: API key resolution from environment references

Any `apiKey` value of the form `"env:VAR_NAME"` SHALL be resolved at provider-creation time by reading `process.env.VAR_NAME`. If the variable is unset or empty and the provider is actually used (not just configured), `getModel()` SHALL throw with a message naming the variable.

Plain string `apiKey` values SHALL be used as-is, and when one is present a warning SHALL be logged (via the structured logger) that plain-string keys are discouraged.

API key values SHALL NEVER be included in log output.

#### Scenario: Env reference with missing variable

- **WHEN** a config sets `apiKey: "env:MY_UNSET_KEY"`, `MY_UNSET_KEY` is not in the environment, and `registry.get("that").getModel("m1")` is invoked
- **THEN** the call SHALL throw an Error whose message contains `MY_UNSET_KEY` and does NOT contain any API-key-looking string

### Requirement: Default model selection

`ProvidersConfig` SHALL include an optional top-level `defaultModel: string` in `providerId/modelId` form. Consumers (the CLI) SHALL use it when no `-m / --model` flag is passed.

If neither `defaultModel` nor a CLI override is provided, the CLI SHALL exit with a non-zero code and a message asking the user to configure a provider, per the open question resolved in `spec.md` §20.

#### Scenario: CLI invoked without a configured default

- **WHEN** a user runs `chimera run "hello"` with a config that has providers defined but no `defaultModel` and no `-m` flag
- **THEN** the process SHALL exit with a non-zero status and stderr SHALL contain a message directing the user to set `defaultModel` or pass `-m`
