## Why

Chimera currently has no visibility into how many tokens a session has consumed or how much of the model's context window is left. Users running long-form work cannot judge when to wrap up a thread, switch models, or trigger `/compact`, and operators cannot confirm cost. Other coding agents surface this prominently; we should too. This data is also a hard prerequisite for the planned compaction trigger (`add-compaction` currently relies on a `length/4` heuristic), so getting real provider-reported usage in place now removes a guess from a future critical path.

## What Changes

- Capture per-step token usage from the AI SDK stream — read `usage` off the `finish-step` and `finish` parts of `streamText` (input/output/total tokens, plus cached-read / cached-write when the provider supplies them).
- Add a `Usage` aggregate to `Session` (`@chimera/core`) tracking cumulative `inputTokens`, `outputTokens`, `cachedInputTokens`, `totalTokens`, plus `lastStep` (the most recent step's deltas) and `stepCount`. Persist it with the session snapshot so resumed sessions retain their running totals.
- Emit a new `usage_updated` event from the agent loop on every `finish-step`, carrying the cumulative `Usage` and the just-finished step's deltas. Include `contextWindow` (resolved from model metadata) and `usedContextTokens` (the running input-token estimate for the next call) so consumers can render "remaining budget" without re-deriving it.
- Add a model-metadata layer exposing `contextWindow` per known model. Wire well-known models (Anthropic Claude 3.5/3.7/4.x, OpenAI gpt-4.1/4o/o-series, etc.) with hard-coded defaults; allow `config.models.<ref>.contextWindow` overrides in `~/.chimera/config.json` for unknown or future models. When a model has no known window and no override, fall back to a documented conservative default and emit a one-shot warning rather than silently rendering "unknown".
- Add a TUI status-bar widget that renders tokens-used / context-window with a percentage and a per-step delta (e.g. `41.2k / 200k (21%) +1.4k`). The widget updates live as `usage_updated` events arrive and resets visually when a new session starts.
- Expose `usage` on `GET /v1/sessions/:id` and stream `usage_updated` over the SSE event stream so non-TUI clients see the same data.
- **Forward-compatible with compaction**: `@chimera/compaction`, when it lands, MAY consume `session.usage.totalTokens` directly instead of (or in addition to) the heuristic estimator. This change does not implement the threshold trigger — it just makes the number available.

## Capabilities

### New Capabilities

- `token-usage-tracking`: capture provider-reported usage per step, aggregate across the session, persist with snapshots, expose via events / server / TUI widget, and resolve per-model context windows.

### Modified Capabilities

None. `agent-core` gains a usage hook on `finish-step` but its existing requirements do not change. `tui` gains a status-bar widget but the StatusBar contract is already widget-based and additive.

## Impact

- **`@chimera/core`**: `Session` gains a `usage: Usage` field; agent loop reads `usage` off `finish-step` parts, updates the aggregate, emits `usage_updated`. New event variant added to `AgentEvent` and `AgentEventEnvelope`.
- **`@chimera/providers`** (or a new lightweight `@chimera/models` table): a `contextWindowFor(providerId, modelId)` resolver. Existing `Provider` interface is unchanged.
- **`@chimera/cli`**: `ChimeraConfig` gains an optional `models: Record<modelRef, { contextWindow?: number }>` block; resolver wires the override into `ModelConfig`.
- **`@chimera/server`**: `GET /v1/sessions/:id` payload gains `usage`; SSE event stream forwards the new `usage_updated` envelope (no new endpoint, just a passthrough of the new event variant).
- **`@chimera/tui`**: new `UsageWidget` rendered in the right-hand status-bar group; subscribes to `usage_updated` events.
- **Persistence**: session JSON snapshot gains a `usage` field. Older snapshots without it deserialize with `usage` zero-initialized.
- **Cost / risk**: zero additional model calls — usage data already rides on the existing stream parts.
- **Forward links**: `add-compaction` (already proposed) can read `session.usage.totalTokens` when this lands; compaction is not blocked on this change but benefits from it.
