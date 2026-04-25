## Context

The agent loop in `@chimera/core` consumes `streamText` parts but discards the `usage` payload that the AI SDK attaches to `finish-step` and `finish`. The SDK already normalizes provider-specific shapes (Anthropic `usage`, OpenAI `usage`, etc.) into a `LanguageModelUsage` object with `inputTokens`, `outputTokens`, `totalTokens`, and — provider permitting — `cachedInputTokens`. Reading those fields is essentially free: no extra calls, no provider-specific branching.

`Session` today carries `model`, `messages`, `toolCalls`, and a few status fields, but no rolling counter. The TUI's status bar already supports right-aligned widgets (`StatusBar` accepts a `right` widget array), so adding a usage indicator does not require layout work — only a new widget and a subscription to a new event variant.

The pending `add-compaction` change estimates tokens with `length / 4`. That heuristic is fine as a fallback but is wrong by 10–30% on realistic mixed-content sessions and badly wrong when tool outputs contain JSON or base64. Real provider-reported numbers are strictly better. This change does not implement the compaction trigger; it just makes the real number available so a follow-up can use it.

## Goals / Non-Goals

**Goals:**

- Token usage shown in the TUI is provider-reported, not estimated, whenever a step has completed.
- The aggregate is durable: resuming a persisted session shows the same running totals it had on shutdown.
- The shape is forward-compatible with cached-token reporting from providers that expose it (Anthropic prompt caching) without forcing a schema change later.
- Non-TUI clients (server SSE consumers, future web UI, eval harnesses) see the same data through one event variant + one field on the session snapshot.
- Context-window resolution has a clean override path so a user adding a brand-new model in their config does not need a code change to get a meaningful "remaining budget" reading.

**Non-Goals:**

- Cost-in-dollars rendering. Pricing tables are volatile and per-tier; we surface tokens, not money. A future change can layer pricing on top.
- Per-tool or per-step attribution beyond what the SDK already gives us (a `usage` object per step). We do not try to allocate tokens to individual tools.
- Compaction trigger logic — `add-compaction` owns that. This change exposes the input it needs.
- Per-provider rate-limit / quota tracking. Different concern, different telemetry.
- Live mid-step updates. Usage arrives at `finish-step`, not on text deltas; we do not synthesize partial counts.

## Decisions

### D1. Read usage off `finish-step`, aggregate in `Session`

**Decision:** Extend the existing `case 'finish-step'` branch in `agent.ts` to read `part.usage` (an AI-SDK `LanguageModelUsage`), update `session.usage` in place, and emit `usage_updated`. Also read the terminal `finish` part's `totalUsage` as a reconciliation — if they disagree (rare; SDK rounding), trust `totalUsage` for the cumulative number.

**Why:** This is exactly where step boundaries are observed today (we already increment `stepNumber` and persist on this branch). Putting usage in the same place keeps the loop simple and avoids a second walk over the stream.

**Alternatives considered:**

- Subscribing to `stream.usage` (a Promise resolving after the stream ends). Rejected: that fires once at the end, so the TUI cannot update mid-run when a multi-step trajectory is in flight.
- Wrapping the model with a custom middleware to intercept usage. Rejected: more surface area for a value we get for free off the stream.

### D2. `Usage` shape

**Decision:**

```ts
interface Usage {
  inputTokens: number;        // cumulative
  outputTokens: number;       // cumulative
  cachedInputTokens: number;  // cumulative; 0 if provider does not report
  totalTokens: number;        // cumulative; equals input+output (cached counted within input)
  stepCount: number;
  lastStep?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
  };
}
```

**Why:** Cumulative + last-step covers both "session-so-far" and "what just happened" in one shape — matches what the TUI wants to render (`41.2k total +1.4k`). Cached tokens are tracked separately rather than subtracted out, so a UI that wants to show "of which N cached" can do so without a second source of truth. `lastStep` is optional so a fresh session has a defined `Usage` without lying about a step that never happened.

**Alternatives considered:**

- Storing every step's usage as an array. Rejected: unbounded growth, no current consumer, and persistence cost. If we later need a histogram we can add it without breaking this shape.
- Mirroring the AI SDK's `LanguageModelUsage` exactly. Rejected: their shape is per-call, not cumulative, and naming our field `usage` while it means something different is confusing.

### D3. `contextWindow` resolution: table + config override

**Decision:** Add a `@chimera/providers` (or a new tiny `@chimera/models`) table keyed by `providerShape + modelId` returning a `contextWindow: number`. Populate it with the well-known windows for current Claude / GPT model families. `ChimeraConfig` gains:

```jsonc
{
  "models": {
    "anthropic/claude-opus-4-7": { "contextWindow": 1000000 }
  }
}
```

Resolution order: config override → built-in table → conservative fallback (`128_000`) with a one-shot stderr warning naming the unknown model.

**Why:** We need *some* number to compute "remaining budget". Hard-coding a table covers the common case with zero user effort. The override path lets a user wire a brand-new model the day it ships, without waiting for a Chimera release.

**Alternatives considered:**

- Provider-API discovery (e.g. Anthropic `/v1/models`). Rejected: not all providers expose it, and shipping a network call on startup for a static value is overkill.
- Hard-code only, no override. Rejected: forces a code change for any new model.
- Make `contextWindow` required on `ModelConfig`. Rejected: `ModelConfig` is constructed in many places (CLI, server, test fixtures); a required field would ripple. Optional with a resolver keeps blast radius low.

### D4. New event variant, no envelope changes

**Decision:** Add `usage_updated` to the `AgentEvent` union:

```ts
{
  type: 'usage_updated';
  usage: Usage;             // cumulative, post-step
  contextWindow: number;    // resolved from model metadata
  usedContextTokens: number; // == usage.inputTokens (for next call's input estimate)
}
```

The existing `AgentEventEnvelope` shape (eventId, sessionId, ts) carries it as-is.

**Why:** One variant, one consumer surface. `usedContextTokens` is computed at emit time so consumers don't need to know the relationship between cumulative input and "what's about to be sent next" — that's a model-loop detail.

**`usedContextTokens` definition:** This is `usage.inputTokens` from the just-finished step, not the cumulative input total. Successive steps reuse most of the prompt (with prompt caching, providers re-bill it as cached, but the SDK still reports it as input). The latest step's input is the closest proxy for "how full is the context right now". This is what the UI should compare against `contextWindow`.

**Alternatives considered:**

- Reuse `step_finished` and add a `usage` field to it. Rejected: `step_finished` exists for trajectory observability, not budget; mixing concerns makes both events harder to evolve. Two events is fine.
- Emit on every text delta with an estimate. Rejected: fakes precision; the TUI can show "streaming…" already.

### D5. TUI widget on the right-hand status group

**Decision:** Add `UsageWidget` rendered in the existing right-hand status group alongside the sandbox tag:

```
[sandbox:overlay] · 41.2k / 200k (21%) +1.4k
```

It subscribes to `usage_updated` (via the existing event subscription in `App.tsx`) and re-renders on each update. When `contextWindow` is unknown, it renders `41.2k / —` (no percentage, no panic). Over 80% it goes amber; over 95% it goes red — purely visual, no behavior change.

**Why:** Status bar already supports widgets; placement is a one-liner. Keeping it on the right matches where ambient session info already lives (sandbox mode). Color thresholds are a small affordance that costs nothing and reads at a glance.

**Alternatives considered:**

- Render in the header instead. Rejected: header renders once at session start (it's inside `<Static>`); usage updates live, so it has to be in the dynamic region.
- Dedicated row above hints. Rejected: another row of UI for one number is a poor trade.

### D6. Persistence: extend the session snapshot

**Decision:** `persistSession` already serializes the full `Session` to JSON. Adding `usage` is automatic once it's a field. Deserialization defaults `usage` to a zero-initialized `Usage` when absent so old snapshots resume cleanly.

**Why:** Free. The persistence path is already JSON-shaped and forgives missing fields.

### D7. `contextWindow` lives on resolved model metadata, not on `ModelConfig`

**Decision:** Keep `ModelConfig` (`{ providerId, modelId, maxSteps, ... }`) unchanged. Resolve `contextWindow` once, at the same place that builds `LanguageModel` from `ModelConfig` (the agent factory in `@chimera/cli/factory.ts`), and pass it to the agent as `AgentOptions.contextWindow: number`. Agent stamps it onto every `usage_updated` event.

**Why:** `ModelConfig` is the *user's request* for a model; `contextWindow` is *what we resolved it to*. Keeping those layers separate avoids the "config field that's actually computed" smell. Also keeps `ModelConfig` serializable without bundling a moving table inside it.

**Alternatives considered:**

- Add `contextWindow?: number` to `ModelConfig`. Rejected per above.
- Re-resolve `contextWindow` inside the agent on every event emit. Rejected: it never changes during a session; resolve once.

## Risks / Trade-offs

- **[Provider does not report usage]** → `part.usage` may be `undefined` on some custom providers. Mitigation: treat missing usage as a zero-delta step (do not emit `usage_updated`); log once per session at debug level so a developer can spot it. The TUI keeps its last-known value and stays useful for the rest of the session.
- **[`cachedInputTokens` semantics differ across providers]** → some providers count cache reads as input, others report them separately. Mitigation: take the SDK's normalized field at face value; document that "cached" is provider-defined. We expose it but do not derive cost from it.
- **[Built-in context-window table goes stale]** → new model ships, table is wrong. Mitigation: config override is first in resolution order; warn on unknown model. We do not block startup on this.
- **[Cumulative drift over many steps]** → if `finish-step` and the terminal `finish.totalUsage` disagree, we end up with a slightly off number. Mitigation: at run end, reconcile `session.usage.totalTokens` against `finish.totalUsage`; emit one final `usage_updated` if they differ. Magnitude is small enough that the TUI will not flicker visibly.
- **[Test fixtures need usage data]** → existing tests stub `streamText` and may not include `finish-step.usage`. Mitigation: wire fixtures to emit a default `{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }` so the agent loop's new branch is exercised without per-test bespoke data.

## Migration Plan

Additive across the board.

1. Land `Usage` type, agent-loop hook, and event variant first; `usage_updated` simply nobody-listens-to-it on day one.
2. Land `contextWindow` table + config override; agent factory resolves and passes through.
3. Land server passthrough (`GET /v1/sessions/:id` includes `usage`; SSE forwards `usage_updated`). No new routes.
4. Land TUI widget last; it is a pure consumer of (1)–(3) and can be rolled out independently.

Existing persisted sessions resume without `usage`; the agent zero-initializes on load. No migration script needed.

## Open Questions

- Should we emit `usage_updated` on session resume (with cumulative-but-no-`lastStep`) so a TUI rendering a resumed session has a value before the first step finishes? Proposed: **yes** — emit a one-shot "snapshot" `usage_updated` immediately after `session_started` for resumed sessions; first-time sessions skip it because the totals are zero. Tasks should reflect this.
- Should `cachedInputTokens` be surfaced in the TUI string, or kept in the data payload only? Proposed: **data only** for now; the percentage already conveys the load. A `/usage` slash command (future) can show the detailed breakdown.
- Subagents have their own sessions; do we sum usage across the tree for the parent's TUI display? Proposed: **no** in this change. Each session's TUI shows its own usage; subagent rollup is a future call.
