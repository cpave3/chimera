## 1. Types and event variant

- [x] 1.1 Add `Usage` interface to `@chimera/core` `types.ts` with `inputTokens`, `outputTokens`, `cachedInputTokens`, `totalTokens`, `stepCount`, optional `lastStep`.
- [x] 1.2 Add `usage: Usage` field to `Session`; default-initialize to all zeros in the `Agent` constructor's "no prior session" branch.
- [x] 1.3 Add `usage_updated` variant to the `AgentEvent` union in `events.ts` with `usage`, `contextWindow`, `usedContextTokens` fields.
- [x] 1.4 Add `contextWindow: number` to `AgentOptions`; thread it through the constructor and store on the agent instance.

## 2. Persistence

- [x] 2.1 Update `persistSession` to include `usage` automatically (it's a session field; verify JSON round-trip).
- [x] 2.2 Update session deserialization (wherever sessions are loaded from disk) to default `usage` to zero-init when absent.
- [x] 2.3 Unit test: round-trip a session with non-zero `usage` and confirm equality.
- [x] 2.4 Unit test: load a fixture snapshot lacking `usage` and confirm it loads with zeroed `usage` and no error.

## 3. Agent loop integration

- [x] 3.1 In `agent.ts`, extend the `case 'finish-step'` branch to read `part.usage`; if present, update `session.usage` cumulative fields and replace `lastStep`.
- [x] 3.2 Increment `session.usage.stepCount` only when `part.usage` is present; log debug-level warning once per session when usage is missing.
- [x] 3.3 After updating `session.usage`, push a `usage_updated` event onto the queue with cumulative `usage`, the resolved `contextWindow`, and `usedContextTokens` set to the current step's `inputTokens`.
- [x] 3.4 Capture per-run accumulated step deltas in a local; on the terminal `finish` part read `totalUsage` and reconcile against the run delta — adjust `session.usage` and emit one final `usage_updated` if they differ.
- [x] 3.5 Emit a snapshot `usage_updated` immediately after the agent's first `session_started` of a run when `session.usage.totalTokens > 0` (resumed-session case) and skip otherwise.
- [x] 3.6 Unit tests for the `finish-step` branch: usage present updates totals + emits event; usage absent emits no event and leaves counters untouched; cached tokens accumulate; reconciliation adjusts when `totalUsage` differs.
- [x] 3.7 Unit test: resumed-session snapshot event fires once and only when prior totals are non-zero.

## 4. Context window resolution

- [x] 4.1 Add a built-in context-window table keyed by `(providerShape, modelId)` — populate Anthropic Claude 3.5/3.7/4.x and OpenAI gpt-4.1 / 4o / o-series families with documented windows.
- [x] 4.2 Export a `resolveContextWindow({ providerShape, providerId, modelId, override })` helper from `@chimera/providers` (or new `@chimera/models`).
- [x] 4.3 Add `models?: Record<string, { contextWindow?: number }>` to `ChimeraConfig`; the key is the `<providerId>/<modelId>` model ref.
- [x] 4.4 Update `@chimera/cli/factory.ts` to call `resolveContextWindow` and pass the result as `AgentOptions.contextWindow`.
- [x] 4.5 Implement the once-per-CLI-process unknown-model warning (deduped on `providerId/modelId`).
- [x] 4.6 Unit tests: config override beats table; table entry beats fallback; fallback returns `128000` and warns exactly once for repeated misses on the same model ref.

## 5. Server passthrough

- [x] 5.1 Update the `GET /v1/sessions/:id` handler in `@chimera/server` to include `usage` on the response payload.
- [x] 5.2 Confirm SSE forwarding: `usage_updated` rides the existing event-stream pipe with no new code; add a regression test that subscribes and asserts the event arrives.
- [x] 5.3 Update any OpenAPI / type schema for the session response to reflect the new `usage` field.

## 6. TUI widget

- [x] 6.1 Create `packages/tui/src/UsageWidget.tsx` that takes `usage`, `contextWindow`, `usedContextTokens`, `unknownWindow` props and renders the formatted string with theme-driven color thresholds (<80%, 80–95%, ≥95%).
- [x] 6.2 Implement a `formatTokens(n)` helper producing `41.2k`, `1.05M`, etc.
- [x] 6.3 In `App.tsx`, subscribe to `usage_updated` events from the session stream, store `{ usage, contextWindow, usedContextTokens }` in component state, and render `<UsageWidget>` in the existing right-hand `sessionRight` status-bar group.
- [x] 6.4 Hide the widget entirely until the first `usage_updated` event has been received in the current TUI process.
- [x] 6.5 Snapshot test for `UsageWidget` covering: pre-first-event hidden state, normal render, amber threshold, red threshold, unknown-window render.

## 7. Test-fixture updates

- [x] 7.1 Audit existing tests that stub `streamText` / model streams; add a default `finish-step.usage` to fixtures so the new code path is exercised.
- [x] 7.2 Update or replace any helper in `@chimera/core` test setup that constructs `AgentOptions` to provide a default `contextWindow` (e.g. `200000`).

## 8. Documentation

- [x] 8.1 Update `README.md` with a short note on the usage indicator and how to override `contextWindow` via config.
- [x] 8.2 Add a `models` config example to `PROVIDERS.md` (or wherever provider config is documented) showing a `contextWindow` override.
- [x] 8.3 Cross-reference: in `add-compaction`'s open-questions / design, note that the threshold trigger can consume `session.usage.totalTokens` once both changes land.

## 9. End-to-end validation

- [ ] 9.1 Run a real session against a configured provider; confirm the TUI widget appears after the first step and updates on subsequent steps. **(manual; covered at the integration level by `packages/server/test/app.test.ts` "SSE events endpoint replays buffered events with ?since" — drives a real run, asserts `usage_updated` rides the bus, and verifies `GET /v1/sessions/:id` reflects post-run cumulative usage.)**
- [ ] 9.2 Persist mid-run, restart, and confirm the widget reflects the resumed totals immediately on the next prompt. **(manual; covered at the unit level by `packages/core/test/usage.test.ts` "snapshot usage_updated immediately after session_started for resumed sessions".)**
- [ ] 9.3 Configure an unknown model ref and verify the once-per-process warning + fallback window + `?` glyph in the widget. **(manual; covered at the unit level by `packages/providers/test/context-window.test.ts` and `packages/tui/test/UsageWidget.test.tsx` unknown-window case.)**
