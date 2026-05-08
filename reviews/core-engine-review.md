# Core engine code-quality review

Scope: `packages/core/src/` and `packages/core/test/`. Severity: `[crit]` / `[high]` / `[med]` / `[low]`. Every finding cites a verified `file:line` and a concrete recommendation.

---

## 1. `runInternal` complexity (`packages/core/src/agent.ts:507–938`)

**Overall sizing:** ~430 lines (from `runInternal` entry to closing `}`), of which ~340 lines are the `for await … switch` engine loop (L629–869). This remains the densest single function in `packages/core`.

### `[high]` Deeply-nested switch over the SDK stream

`agent.ts:629` opens a `for await (const part of stream.fullStream)` and immediately falls into an 11-case `switch (part.type)`. The individual cases are themselves dense:

- `text-delta` is 25 lines (`agent.ts:638–664`), holding the shadow/replay logic inline.
- `text-end` is 36 lines (`agent.ts:666–705`), also with inline shadow cleanup.
- `tool-result` is 29 lines (`agent.ts:741–772`), holding the skill-activation inline.
- `finish-step` is 44 lines (`agent.ts:791–838`), holding inline persist-and-usage logic.

Recommendation: factor the loop body into an internal `StreamProcessor` class (or a plain async generator) whose sole job is `SDKStreamPart → AgentEvent[]`. The `Agent` keeps raise/resolve permission, run-state, and top-level orchestration; the loop keeps event translation. This also makes the shadow/text dedup logic unit-testable in isolation without standing up a mock language model.

### `[high]` Dual mode-switch paths (`agent.ts:515–559` vs `agent.ts:390–412`)

`runInternal` duplicates the "apply a queued mode switch" logic that already exists in `queueModeSwitch` (`agent.ts:390–412`). Both branches do:

1. check `modeResolver` presence,
2. call `this.modeResolver(name)`,
3. mutate `this.opts.systemPrompt`, `this.opts.tools`, `this.session.mode`,
4. optionally emit a `mode_changed` event.

`queueModeSwitch` does this for idle agents; `runInternal` does it again for agents that had a switch queued mid-run. Divergence risk is material: `queueModeSwitch` calls `writeSessionMetadata` at `agent.ts:405`; the inline `runInternal` version does not, so a mode switch that is queued and then drained at run-start is persisted to disk later (or not at all) compared to one applied when idle.

Recommendation: extract a single `applyModeSwitch(name, emit)` routine shared by both paths. Both should trigger `writeSessionMetadata` with the same error-handling posture.

### `[med]` `runInternal` owns usage reconciliation inline (`agent.ts:839–850`)

The `finish` case (`agent.ts:840`) calls `reconcileFinalUsage` and conditionally re-emits `usage_updated`. The reconciliation logic is already well-factored in `usage.ts`, but the *decision to emit* is buried in the switch. Moving this to the `StreamProcessor` (per above) or a small `UsageReconciler` wrapper makes the agent-level flow easier to follow.

### `[med]` Post-loop terminal persistence (`agent.ts:893–908`)

After the `for await` exits, `runInternal` performs a *second* persist to capture the final `messages`/`toolCalls` array, then a *third* persist for the `run_finished` event (`agent.ts:920–928`). These two writes are sequential and could be combined into one `persistSession(session, combinedEvent)` if `PersistedEvent` were extended to include `run_finished` semantics, reducing the number of `fs.appendFile` calls by one per run. Not critical, but observable in high-throughput scenarios.

---

## 2. Content-aware text-id dedup (commit `ab8b8f4`)

### `[med]` No test for *diverging* shadow content within the same step

The existing test at `packages/core/test/agent.test.ts:328–402` covers the "same step, text → tool → text" happy path where the second text block is *new* (`"I'll check..."` then `"Done!"`). This passes. What is untested is the branch where the second text block is a *diverging prefix* of the original — e.g. first text block `"hello world"`, then a tool call, then a second text block `"hello there"` under the same id.

In the `text-delta` handler (`agent.ts:638–664`):
- `shadow.buf += part.text` accumulates the *entire* buffer against the stored copy.
- The divergence check is `!stored.startsWith(shadow.buf)` (L650). This means divergence is detected character-by-character. If the provider emits a first delta `"hello "`, then a tool call, then a second delta `"there"`, the shadow buffer becomes `"hello there"` — which does not start with stored `"hello world"` — divergence is detected, synthetic id assigned, and the *entire* shadow buffer (`"hello there"`) is emitted as a single delta. This is correct (the TUI sees `"hello there"` as one new block), but it is also a subtle multi-delta combining behaviour that is not verified by any test.

### `[med]` Shadow emission on `text-end` for "strict prefix" branch (`agent.ts:677–696`)

Consider: stored text = `"abc"`, then a tool call, then same-id text emits only `"ab"`. The `text-end` handler reaches `agent.ts:677`:

```ts
} else if (shadow.buf.length > 0 && shadow.buf !== emittedTextById.get(part.id)) {
```

`shadow.buf === "ab"`, stored === `"abc"`. The condition is true (`"ab" !== "abc"`). The code enters the block and emits the text under a new synthetic id. However — and this is correct — it overwrites `emittedTextById.set(part.id, shadow.buf)` with `"ab"`, meaning that if a *third* text block later reuses the same id, it will be compared against `"ab"` (the shorter version) rather than `"abc"` (the original). This is intentional for cross-step id resets but could surprise readers. A one-line comment at `agent.ts:695` explaining why we overwrite the stored text with the shorter version would prevent accidental "fixing."

### `[low]` `textStreams` leaks if `text-end` never arrives

`textStreams` (`agent.ts:581`) accumulates per-id text in a `Map`. If the stream terminates abnormally (error, abort, or a provider bug) *between* `text-start` and `text-end` for some id, the map retains the partial string for the lifetime of `runInternal` — a minor memory leak bounded by the size of one truncated assistant response. When `runInternal` exits, the map is garbage-collected, so it is not a true leak, just stale state inside the loop. No action needed unless the function is ever converted to long-lived form.

---

## 3. `event-queue.ts` (`packages/core/src/event-queue.ts`)

### `[high]` No tests exist for `EventQueue`

The file is at `packages/core/src/event-queue.ts` and is not referenced by any test file under `packages/core/test/`. It implements a hand-rolled async producer/consumer channel:

- `push()` resolves waiters FIFO (`event-queue.ts:12`).
- `close()` drains all pending waiters with `{ done: true }` (`event-queue.ts:23`).
- `next()` returns buffered values or enqueues a resolver (`event-queue.ts:29`).

### `[high]` Race between `push` and `close` can drop `close` signals

`event-queue.ts:10–18`:

```ts
push(value: T): void {
  if (this.closed) return;
  const resolver = this.resolvers.shift();
  if (resolver) {
    resolver({ value, done: false });
  } else {
    this.buffer.push(value);
  }
}
```

`close()` (`event-queue.ts:20–27`):

```ts
close(): void {
  if (this.closed) return;
  this.closed = true;
  for (const resolver of this.resolvers) {
    resolver({ value: undefined as unknown as T, done: true });
  }
  this.resolvers = [];
}
```

There is no locking. Consider the interleaving:

1. Consumer A calls `next()`; buffer is empty; A's resolver is pushed to `this.resolvers`.
2. Producer calls `close()`: sets `this.closed = true`, begins iterating `this.resolvers`.
3. Concurrent producer calls `push(x)`:
   - `this.closed` is already `true` → `return`. Value is dropped.
4. `close()` continues and resolves A with `{ done: true }`.

Result: A gets the close signal and exits, so there is no *consumer-visible* stall. But if there is a *second* consumer (there shouldn't be — `drain` is the only caller), or if the producer intended to push one final event before close, it is silently lost. More importantly, the `undefined as unknown as T` cast at `event-queue.ts:35` is used to synthesise a `done` result without a value, but TypeScript will not type-check it correctly — `IteratorResult<T>` expects `value: T | undefined` in some configurations, and the cast masks a real typing gap.

Recommendation: add a test suite covering at minimum:
- Basic FIFO ordering across waiters and buffer.
- `push` after `close` is a no-op (values dropped).
- `close` resolves all outstanding waiters.
- Multiple `close` calls are idempotent.
- Stress test: rapid concurrent `push`/`close` from multiple producers (exercises the lack of atomicity).

Fix: make `close` take ownership of the resolvers array before iterating, so no concurrent `push` can shift from it mid-flight:

```ts
close(): void {
  if (this.closed) return;
  this.closed = true;
  const waiters = this.resolvers;
  this.resolvers = [];
  for (const resolver of waiters) {
    resolver({ value: undefined as unknown as T, done: true });
  }
}
```

This does not make the queue fully thread-safe, but it closes the ABA window on the resolver list.

---

## 4. Type-safety gaps

### `[high]` Seven `as { <field>?: unknown }` casts on SDK stream parts (`agent.ts:709, 744, 777, 798, 841`, plus `agent.ts:943, 951` in helpers)

Each `switch` case reads a field from an AI SDK `part` by casting the part to a permissive anonymous type, then indexing into it:

- `agent.ts:709`: `const args = (part as { input?: unknown }).input;`
- `agent.ts:744`: `const result = (part as { output?: unknown }).output;`
- `agent.ts:777`: `const errorValue = (part as { error?: unknown }).error;`
- `agent.ts:798`: `const stepUsage = readStepUsage((part as { usage?: unknown }).usage);`
- `agent.ts:841`: `const total = readStepUsage((part as { totalUsage?: unknown }).totalUsage);`

These work because the AI SDK's `fullStream` parts are runtime-distinguished by `type`, but TypeScript does not narrow the fields per case. A single typed adapter — e.g. a `type PartView = { toolCallArgs(part): unknown }` interface — would centralise the casts and make SDK upgrades safer. Alternatively, if the project upgrades the AI SDK dep, newer versions may ship discriminated unions for `fullStream` that remove the need for casts entirely.

Recommendation: wrap the five casts plus the `extractReadPath`/`extractTarget` helpers into a small `part-adapter.ts` module with named functions:
- `toolCallArgs(part)`, `toolCallResult(part)`, `toolCallError(part)`, `finishStepUsage(part)`, `finishTotalUsage(part)`.

### `[med]` `tool-result` does not type-check `rec` before accessing `.args` (`agent.ts:757`)

```ts
if (info.name === 'read' && this.opts.skillActivation) {
  const readPath = extractReadPath(rec?.args);
```

`rec` is found by `this.session.toolCalls.find((t) => t.callId === info.callId)` (L745). The `find` can return `undefined`; the code already guards with `if (rec)` at L746 for other properties, but the `skillActivation` block uses optional chaining (`rec?.args`) instead of an explicit guard. If `rec` is missing, `extractReadPath(undefined)` returns `undefined`, which is harmless, but the inconsistency (explicit guard elsewhere, optional chain here) is a readability friction.

### `[med]` `usage.ts:5` — `raw as { inputTokens?: unknown; … }` is used for SDK usage objects

`readStepUsage` in `usage.ts` takes `unknown` and casts to a permissive shape. This is the right place for a single cast (better than spreading it across `agent.ts`), but it still means runtime field presence is untrusted. Adding a defensive `typeof` check per field (already present) is fine; the improvement is centralisation, not additional runtime guards.

---

## 5. `persistence.ts` — silent session-metadata write failures

### `[high]` `writeSessionMetadata` failure can silently leave stale metadata (`persistence.ts:71–80`)

`writeSessionMetadata` uses an atomic `writeFile(tmp) → rename(tmp, path)` pattern. `rename` can fail with `EACCES`, `ENOSPC`, `EBUSY`, or `EXDEV` (if `.chimera/sessions/` is a cross-device link for the tmp file). If `rename` throws, the exception propagates to the caller, but every call site in `agent.ts` silently swallows the rejection:

- `agent.ts:248`: `appendSessionEvent(…).catch(() => {})` — this is for the event file, not metadata.
- `agent.ts:279`: same pattern.
- `agent.ts:835`: `persistSession(…).catch()` — `persistSession` writes both event and metadata concurrently (via `Promise.all` at `persistence.ts:104`), so a metadata failure is swallowed here too.
- `agent.ts:905`: same.
- `agent.ts:929`: same.

Specifically, the `queueModeSwitch` path (`agent.ts:405`) has the most dangerous silent swallow:

```ts
void writeSessionMetadata(this.session, this.opts.home).catch(() => {});
```

This is called after a mode switch is applied to the in-memory session. If `rename` fails, the agent is now running with the *new* mode but the on-disk metadata still records the *old* mode. On resume (e.g. after a crash/restart), the session loads with the stale mode, which can change tool availability or system prompt unexpectedly.

### `[med]` `persistSession`'s concurrent writes have different atomicity guarantees (`persistence.ts:98–108`)

```ts
export async function persistSession(…): Promise<void> {
  await ensureSessionDir(session.id, home);
  await Promise.all([
    appendSessionEvent(session.id, event, home),
    writeSessionMetadata(session, home),
  ]);
}
```

`appendSessionEvent` is an `fs.appendFile` (not atomic for multi-process; atomic per-append for single process on most POSIX). `writeSessionMetadata` is atomic via tmp+rename. If `writeSessionMetadata` succeeds but `appendSessionEvent` fails (disk full), the metadata is updated but the event log is not — leaving the metadata ahead of the log. The reverse (metadata fails, event succeeds) is also possible and similarly leaves inconsistent state.

Recommendation: the comment at `persistence.ts:96–97` says the writes "touch different files and are independent, so they run concurrently." But independence is not the same as atomicity. If consistency between metadata and event log matters (and it does for resume — `loadSession` reads both), wrap them in an explicit two-phase write: write the event first, then metadata, and surface the error to the caller. Alternatively, accept the current best-effort model but *log* the failure so an operator can detect a pattern of stale metadata:

```ts
void writeSessionMetadata(…).catch((err) => {
  process.stderr.write(`[chimera] warn: failed to write session metadata: ${err.message}\n`);
});
```

### `[low]` `readLatestStepSnapshot` silently skips malformed non-trailing lines (`persistence.ts:181–192`)

When `JSON.parse(line)` throws, the code checks `isLast` and emits a warning for trailing lines, but for *non-trailing* malformed lines it also emits the same warning (`persistence.ts:190`). That is correct behaviour — skip and warn — but there is no recovery from mid-file corruption. If a single line in a 1000-line `events.jsonl` is corrupted, all subsequent `step_finished` snapshots are lost (the loop continues but `latest` is never updated). A future enhancement could attempt to scan forward to the next well-formed `step_finished`, but this is not a defect today, just a resilience gap.

---

## 6. Usage reconciliation patterns

### `[med]` `reconcileFinalUsage` adds deltas, not replaces — but `runDelta` is zeroed per run only (`usage.ts:64–76`)

`reconcileFinalUsage` computes the difference between the terminal `totalUsage` and the per-step `runDelta`, then adds that difference to the session aggregate. This is correct when `runDelta` accurately reflects what was already added by `applyStepUsage` in the current run. However:

- If a `finish-step` part has `usage === undefined` (provider omitted it), `runDelta` does not accumulate for that step, but `session.usage` was already mutated by prior steps. The terminal `totalUsage` then reconciles against an incomplete `runDelta`, which can produce negative deltas if the SDK's `totalUsage` *does* include the step that was missing earlier.

Concrete example:
- Step 1: usage reported → `runDelta.totalTokens = 100`, `session.usage.totalTokens = 100`.
- Step 2: usage omitted → `runDelta` stays at 100, `session.usage` stays at 100.
- Terminal `totalUsage.totalTokens = 250` → reconciliation adds `250 - 100 = 150` → `session.usage.totalTokens = 250`.

This works numerically, but the mental model is fragile: the reconciliation is only correct because `totalUsage` is authoritative and the arithmetic happens to land on the right number. If a provider reports per-step `inputTokens: 0, outputTokens: 0, totalTokens: 0` (zero-usage step) but the terminal `totalUsage` is non-zero, the `runDelta` includes 0 for that step and the reconciliation still adjusts upward — also correct, but not obviously so.

Recommendation: a comment inside `reconcileFinalUsage` explaining that `runDelta` may be a strict subset of the actual steps, and that the delta arithmetic compensates for missing per-step data, would prevent a well-meaning refactor from breaking it.

### `[low]` `usageMissingLogged` is a single boolean (`agent.ts:615`)

The flag `usageMissingLogged` ensures the "provider did not report usage on finish-step" debug line is emitted once per run. If a provider omits usage on *multiple* steps, only the first is warned. Changing this to `usageMissingCount: number` and warning every Nth occurrence would help diagnose systematic provider issues without spam.

---

## Summary table

| Severity | File:line | Finding | Recommended fix |
|----------|-----------|---------|-----------------|
| `[high]` | `agent.ts:629` | `runInternal` switch loop is ~340 lines inline | Extract `StreamProcessor`; unit-test shadow logic separately |
| `[high]` | `agent.ts:515–559` vs `390–412` | Mode-switch logic duplicated between idle-path and run-start path | Share `applyModeSwitch(name, emit)`; both paths persist metadata |
| `[high]` | `event-queue.ts` (all) | No tests; push/close race on resolver list | Add stress tests; snapshot `resolvers` before iterating in `close` |
| `[high]` | `persistence.ts:71–80` + `agent.ts:405` | `writeSessionMetadata` failure silently leaves stale mode on disk | Log warning on metadata write failure; consider sequential persist |
| `[med]` | `agent.ts:709,744,777,798,841` | `as { input?: unknown }` casts on SDK parts | Centralise in `part-adapter.ts` with named accessor functions |
| `[med]` | `agent.ts:635–695` | Shadow dedup logic has no test for diverging-prefix edge case | Add test: stored `"hello world"`, replay `"hello there"` within same step |
| `[med]` | `agent.ts:835,905,929` | `persistSession` failures silently swallowed | Surface at debug log or propagate (per-project policy) |
| `[med]` | `persistence.ts:104` | Concurrent metadata + event writes can diverge on partial failure | Sequentialise or add retry with logging |
| `[med]` | `usage.ts:64–76` | `reconcileFinalUsage` assumes `runDelta` is well-formed | Add comment explaining missing-step compensation |
| `[low]` | `agent.ts:581–703` | `textStreams` could leak entry if `text-end` never arrives | Acceptable if `runInternal` is single-run; document if refactored |
| `[low]` | `agent.ts:615` | `usageMissingLogged` boolean only warns once per run | Consider `usageMissingCount` for systematic-provider diagnostics |
| `[low]` | `agent.ts:695` | `emittedTextById.set(part.id, shadow.buf)` overwrites with shorter text | Add one-line comment explaining cross-step id reset semantics |

---

*Review generated against commit `ab8b8f4` (content-aware text-id dedup) and current `HEAD` at `packages/core/src/`.*
