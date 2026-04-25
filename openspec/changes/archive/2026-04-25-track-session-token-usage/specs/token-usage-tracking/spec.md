## ADDED Requirements

### Requirement: Session usage aggregate

`@chimera/core` SHALL extend `Session` with a `usage` field of shape:

```
{
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  totalTokens: number,
  stepCount: number,
  lastStep?: { inputTokens, outputTokens, cachedInputTokens, totalTokens }
}
```

A new `Session` SHALL initialize `usage` to all-zeroes with `lastStep` absent. The aggregate SHALL be cumulative across the entire session lifetime, including across resumes from persistence.

#### Scenario: Fresh session has zero usage

- **WHEN** a new `Session` is constructed with no prior persisted state
- **THEN** `session.usage.totalTokens` SHALL be `0`, `session.usage.stepCount` SHALL be `0`, and `session.usage.lastStep` SHALL be `undefined`

#### Scenario: Resumed session retains prior totals

- **WHEN** a session is persisted with `usage.totalTokens = 12345`, then loaded back into a new `Agent`
- **THEN** the loaded `session.usage.totalTokens` SHALL be `12345` before any new step runs

### Requirement: Per-step usage capture

On each `finish-step` part observed in the `streamText` stream, the agent loop SHALL read `part.usage` (an AI-SDK `LanguageModelUsage`) and update `session.usage` by adding `inputTokens`, `outputTokens`, `cachedInputTokens` (defaulting to `0` when absent), and `totalTokens` to the cumulative counters, incrementing `stepCount` by `1`, and replacing `lastStep` with the just-observed step's values.

When `part.usage` is `undefined` (provider does not report), the agent loop SHALL leave the cumulative counters unchanged, SHALL NOT increment `stepCount`, and SHALL NOT emit `usage_updated` for that step. It SHALL log a single debug-level message per session noting that usage reporting is unavailable.

#### Scenario: Step with usage updates totals

- **WHEN** a step finishes with `usage = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 }` and the session previously had `usage.totalTokens = 5000`
- **THEN** `session.usage.totalTokens` SHALL equal `6200`, `session.usage.stepCount` SHALL increment by `1`, and `session.usage.lastStep.totalTokens` SHALL equal `1200`

#### Scenario: Step without usage is a no-op for counters

- **WHEN** a step finishes with `part.usage` undefined and the session had `usage.totalTokens = 5000`
- **THEN** `session.usage.totalTokens` SHALL remain `5000`, `session.usage.stepCount` SHALL be unchanged, and no `usage_updated` event SHALL be emitted for this step

#### Scenario: Cached tokens accumulate when reported

- **WHEN** a provider reports `cachedInputTokens: 800` on a step
- **THEN** `session.usage.cachedInputTokens` SHALL increase by `800` while `session.usage.inputTokens` is updated according to the same `part.usage.inputTokens` value the provider reported

### Requirement: Final reconciliation against `totalUsage`

When the `streamText` `finish` part is observed, the agent loop SHALL compare its `totalUsage.totalTokens` against the per-step sum accumulated in `session.usage.totalTokens` (relative to the cumulative value at run start). If they differ, the agent loop SHALL adjust `session.usage` to match `totalUsage` and emit a final `usage_updated` event reflecting the corrected aggregate.

#### Scenario: Disagreement is reconciled in favor of totalUsage

- **WHEN** per-step accumulation yields `+1200` tokens for the run but `finish.totalUsage.totalTokens` indicates `+1230` for the same run
- **THEN** `session.usage.totalTokens` SHALL be adjusted upward by `30`, and one final `usage_updated` event SHALL be emitted carrying the reconciled aggregate

#### Scenario: Agreement emits no extra event

- **WHEN** per-step accumulation matches `finish.totalUsage` exactly
- **THEN** no additional `usage_updated` event SHALL be emitted on `finish`

### Requirement: `usage_updated` event

The `AgentEvent` union SHALL include a `usage_updated` variant of shape:

```
{
  type: 'usage_updated',
  usage: Usage,
  contextWindow: number,
  usedContextTokens: number
}
```

The agent loop SHALL emit this event after each successful per-step usage update. `usage` SHALL be the cumulative session aggregate at the moment of emission. `contextWindow` SHALL be the resolved window for the session's model (see "Context window resolution"). `usedContextTokens` SHALL be the most recent step's `inputTokens` value (the closest proxy for "current prompt size"), or `0` when no step has yet completed.

The event SHALL be carried over the existing `AgentEventEnvelope` shape with `eventId`, `sessionId`, and `ts` populated by `EventBus.publish`.

#### Scenario: Event carries cumulative and last-step data

- **WHEN** a step finishes with `inputTokens: 1500, outputTokens: 250` and the cumulative becomes `{ totalTokens: 8000, ... }`
- **THEN** the emitted `usage_updated` event SHALL have `usage.totalTokens = 8000`, `usage.lastStep.totalTokens = 1750`, and `usedContextTokens = 1500`

### Requirement: Resumed-session snapshot event

On `Agent.run()` for a session whose `usage.totalTokens > 0` at start (i.e. a resumed session with prior usage), the agent loop SHALL emit one `usage_updated` event immediately after `session_started` and before the first model call, carrying the persisted aggregate. For a fresh session whose totals are zero, no snapshot event SHALL be emitted.

#### Scenario: Resumed session emits snapshot on first run

- **WHEN** an `Agent` resumes a persisted session with `usage.totalTokens = 12345` and the user issues their first prompt of the new run
- **THEN** the event stream SHALL emit `session_started` followed by `usage_updated { usage.totalTokens: 12345, usedContextTokens: <last persisted lastStep.inputTokens or 0> }` before any text deltas

#### Scenario: Fresh session emits no snapshot

- **WHEN** a brand-new session starts with zero cumulative usage
- **THEN** no `usage_updated` event SHALL be emitted before the first step's `finish-step`

### Requirement: Context window resolution

The agent factory SHALL resolve a `contextWindow: number` for the session's model and pass it to the agent as `AgentOptions.contextWindow`. Resolution order:

1. If `config.models[modelRef].contextWindow` is set in `~/.chimera/config.json`, use that value.
2. Otherwise, look up `(providerShape, modelId)` in a built-in table covering the current Claude and OpenAI families.
3. Otherwise, use the conservative fallback `128000` and emit one stderr warning naming the unresolved model reference. The warning SHALL fire at most once per CLI process per `(providerId, modelId)` pair.

`contextWindow` SHALL be a positive integer. The resolved value SHALL appear on every `usage_updated` event for the session.

#### Scenario: Config override wins over built-in table

- **WHEN** `~/.chimera/config.json` contains `{ "models": { "anthropic/claude-opus-4-7": { "contextWindow": 1000000 } } }` and the session uses that model
- **THEN** `usage_updated.contextWindow` SHALL equal `1000000` regardless of the built-in entry for that model

#### Scenario: Unknown model falls back with warning

- **WHEN** the session uses a model reference for which no override and no table entry exists (e.g. `local/some-experimental`)
- **THEN** `usage_updated.contextWindow` SHALL equal `128000`, and stderr SHALL contain exactly one warning line for that `(providerId, modelId)` pair across the CLI process lifetime

#### Scenario: Built-in table covers a known model

- **WHEN** the session uses `anthropic/claude-sonnet-4-6` and no override is configured
- **THEN** `usage_updated.contextWindow` SHALL equal that model's documented window from the built-in table, and no warning SHALL be emitted

### Requirement: Persistence of usage

`persistSession` SHALL serialize `session.usage` as part of the JSON snapshot. Loading a snapshot that lacks a `usage` field SHALL deserialize with `usage` zero-initialized and `lastStep` absent — no error, no warning.

#### Scenario: Round-trip preserves usage

- **WHEN** a session with `usage.totalTokens = 7777, usage.stepCount = 4, usage.lastStep.totalTokens = 1100` is persisted then loaded
- **THEN** the loaded session SHALL have identical `usage` field values

#### Scenario: Legacy snapshot loads cleanly

- **WHEN** a snapshot file with no `usage` field is loaded
- **THEN** the loaded session SHALL have `usage.totalTokens = 0, usage.stepCount = 0, usage.lastStep = undefined` and no error SHALL be thrown

### Requirement: Server exposure

`@chimera/server` SHALL include the `usage` field on the `GET /v1/sessions/:id` response payload. The SSE event stream SHALL forward `usage_updated` events to subscribers using the same envelope as other agent events; no new endpoint SHALL be added.

#### Scenario: Session GET includes usage

- **WHEN** a client requests `GET /v1/sessions/<id>` for an active session with cumulative usage
- **THEN** the response body SHALL contain a `usage` object with the cumulative `totalTokens` matching the agent's current `session.usage.totalTokens`

#### Scenario: SSE forwards usage_updated

- **WHEN** an agent emits `usage_updated` and a client is subscribed to the session's event stream
- **THEN** the client SHALL receive the event with type `usage_updated` and the same `usage`, `contextWindow`, and `usedContextTokens` fields

### Requirement: TUI usage widget

The TUI SHALL render a usage widget in the right-hand status-bar group. The widget SHALL display tokens-used and context-window in human-readable form (`k`/`M` suffixes), a percentage when `contextWindow` is known, and the most recent step's delta. It SHALL update on every `usage_updated` event the TUI receives.

The percentage SHALL be computed as `usedContextTokens / contextWindow * 100`, rounded to the nearest integer. The widget SHALL render in the theme's default text color when the percentage is below 80, in an amber/warning color from 80 inclusive to 95 exclusive, and in a red/danger color at 95 or above. When `contextWindow` is the conservative fallback value of `128000` AND the model was resolved via the unknown-model fallback path, the widget MAY render a small `?` glyph adjacent to the window value to indicate the value is approximate; an exact glyph and styling are an implementation detail.

When no `usage_updated` event has yet been received in the current TUI session (fresh, non-resumed), the widget SHALL render nothing rather than showing `0 / 200k (0%)` so the bar is not cluttered before any step finishes.

#### Scenario: Widget renders after first step

- **WHEN** a session has just received its first `usage_updated` with `usedContextTokens: 41200` and `contextWindow: 200000`
- **THEN** the widget SHALL render a string of the form `41.2k / 200k (21%) +<delta>k` in the right-hand status group

#### Scenario: Widget hidden before first event

- **WHEN** a fresh session has started and no `usage_updated` has yet arrived
- **THEN** the widget SHALL render no visible output and SHALL NOT occupy a separator in the status bar

#### Scenario: Color escalates near the limit

- **WHEN** `usedContextTokens / contextWindow` is `0.97`
- **THEN** the widget's tokens-used segment SHALL render in the theme's red/danger color
