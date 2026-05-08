# Backend Boundary Review — `server`, `client`, `permissions`

**Date:** 2026-05-08  
**Scope:** `packages/server/src/`, `packages/client/src/`, `packages/permissions/src/` (and tests)  
**Baseline:** Code as of HEAD (post-April-26 changes including hooks, modes, SSE heartbeat, subagent loading)

---

## Summary

Most [high] findings from the 2026-04-26 review remain unaddressed: the HTTP boundary in `server/src/app.ts` still has no request-body validation, SSE frames are still parsed without shape checking, and permission errors are still over-masked. New code since the last review introduces a memory-leak risk in the hook bridge and continues the empty-catch pattern. No new [crit] items.

| Severity | Count |
|----------|-------|
| [crit]   | 0     |
| [high]   | 5     |
| [med]    | 7     |
| [low]    | 5     |

---

## 1. Prior findings — still present

### 1.1 [high] No Zod validation on HTTP JSON bodies (`server/src/app.ts`)

**Citations:**

- `app.ts:51` — `POST /v1/sessions` reads `body.cwd`, `body.model`, `body.sandboxMode`, `body.sessionId` without any schema check. A client sending `{ sandboxMode: 123 }` is accepted silently.
- `app.ts:189` — `POST /v1/sessions/:id/messages` does `String(body.content ?? '')`; on a missing body this produces the literal string `"undefined"` and forwards it to the LLM.
- `app.ts:131` — `POST /v1/sessions/:id/fork` parses body with `.catch(() => ({}))`, silently swallowing malformed JSON.
- `app.ts:209` — `POST /v1/sessions/:id/reload` trusts `body.systemPrompt` is a string; empty string is accepted without complaint.
- `app.ts:222` — `POST /v1/sessions/:id/mode` checks only `typeof body?.mode === 'string'`; other shape issues pass through.
- `app.ts:258` — `POST /v1/sessions/:id/permissions/rules` passes `body.rule` and `body.scope` directly to `gate.addRule` without validation.
- `app.ts:292` — `POST /v1/sessions/:id/permissions/:requestId` reads `body.decision` and `body.remember` without checking against the `'allow' | 'deny'` union.

**Recommendation:** Add a Zod schema per `await c.req.json()` call, reject with 400 on `ZodError`, and remove the `.catch(() => ({}))` swallow in the fork endpoint. The `z` object is already a workspace dependency via `@chimera/core`.

---

### 1.2 [high] SSE frame parsing without validation (`client/src/sse.ts:47–70`)

**Citation:** `client/src/sse.ts:62–69` — `parseBlock` does `JSON.parse(data) as AgentEventEnvelope`. A truncated frame produces a malformed object that propagates to consumers. The surrounding `catch {}` at line 67 swallows the parse failure and returns `null` silently, so the event simply disappears.

**Recommendation:** Parse the envelope through a Zod schema (or the existing `AgentEventEnvelope` type guard if one exists), log parse failures at `debug`, and surface them to the caller (e.g. yield a synthetic `{ type: 'parse_error', raw: data }` event) rather than dropping them silently.

---

### 1.3 [high] Permission error masking (`server/src/app.ts:259–261`)

**Citation:** `app.ts:295–301` — the `try/catch` around `entry.agent.resolvePermission(...)` catches **all** errors (including thrown by `resolvePermission` when the requestId is unknown, or any internal exception) and maps everything to HTTP 409 "already resolved". A corrupted agent state or a programming error in `resolvePermission` is indistinguishable from a genuine race.

**Recommendation:** Narrow the catch to the specific "already-resolved" condition. The core `Agent.resolvePermission` already throws `Error('No pending permission request: ${requestId}')` (`core/src/agent.ts:223`); catch only that exact message (or export a custom error class from core) and let everything else propagate as 500.

---

### 1.4 [med] SSE write after close (`server/src/app.ts:320–327`)

**Citation:** `app.ts:320–327` — the subscriber callback calls `void stream.writeSSE(...)` without checking `c.req.raw.signal.aborted`. After abort, `writeSSE` on a closed stream can throw (Hono's `stream.writeSSE` may reject). The `void` wrapper suppresses the rejection, but the unhandled exception can still crash the process depending on the runtime. The April-26 heartbeat addition (lines 333–335) does not fix this.

**Recommendation:** Wrap the subscriber callback in an `aborted`-gated early return, or unsubscribe synchronously in the abort listener before `resolve()` fires.

---

### 1.5 [med] Empty-catch idioms (multiple locations)

**Citations:**

- `server/src/agent-registry.ts:184–186` — `await entry.activeRun` rejection silently swallowed during `delete()`. Comment says "run errors already surfaced via the event bus", but at least log the rejection at debug.
- `server/src/agent-registry.ts:191–193` — `await entry.hookRunner.fire({ event: 'SessionEnd' })` rejection swallowed with comment "Hook failures must not abort the session lifecycle". Same debug-log suggestion.
- `client/src/sse.ts:34–43` — `reader.cancel()` and `reader.releaseLock()` failures silently swallowed. Fine for cleanup, but the catch blocks should at least be commented.
- `server/src/event-bus.ts:29–33` — subscriber exception swallowed to protect the bus. Explicitly documented at line 31 (`// never let one slow subscriber break the bus`). Acceptable as a conscious policy, but the prior review noted the pattern concern.

**Recommendation:** Add a `logger.debug` call inside each empty catch (or use a shared `safe(fn)` utility) so failures are discoverable in traces.

---

### 1.6 [med] 204 response cast (`client/src/client.ts:89`)

**Citation:** `client.ts:89` — `return undefined as unknown as T`. This double-cast erases the type-level distinction between "no body" and "body expected".

**Recommendation:** Model 204 responses explicitly in the return type (e.g. overload `json<T>(path, init)` vs `json<void>(path, init)` and branch). Non-trivial refactor; keep as backlog.

---

## 2. New findings — code added/modified since 2026-04-26

### 2.1 [med] Hook bridge memory leak (`server/src/hook-bridge.ts`)

**Citation:** `hook-bridge.ts:24, 32–55` — the `inFlight` Map stores `{ name, args }` keyed by `callId` when `tool_call_start` is seen, and deletes on `tool_call_result` / `tool_call_error`. If the agent run is interrupted or crashes before the matching result/error fires, the entry is never removed. This is bounded by the number of concurrent tool calls, but in a long-running session with many interrupted runs it accumulates.

**Recommendation:** Add a cleanup timeout or an explicit `run_finished` purge of orphaned `inFlight` entries, or bound the map size and evict oldest.

---

### 2.2 [med] `toRecord` unsound cast (`server/src/hook-bridge.ts:63–67`)

**Citation:** `hook-bridge.ts:63–67`
```ts
function toRecord(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}
```
This accepts `Date`, `RegExp`, `null` (the `args &&` catches `null`, so fine), but `typeof null === 'object'` is handled by the `args &&` guard. The real issue is that `Array.isArray` rejects arrays but accepts other iterable objects (e.g. `Map`, `Set`), which then get cast. The hook runner later JSON-stringifies this; a `Map` would serialize as `{}` silently.

**Recommendation:** Use a JSON round-trip (`JSON.parse(JSON.stringify(args))`) or an explicit recursive validator to ensure only serialisable values reach the hook payload.

---

### 2.3 [med] `GatedExecutor` hardcodes `tool: 'bash'` for all exec calls (`permissions/src/gated-executor.ts:57–64`)

**Citation:** `gated-executor.ts:57–64`:
```ts
const resolution = await this.gate.request({
  requestId: newRequestId(),
  tool: 'bash',
  target: 'host',
  command: cmd,
  ...
});
```
All commands executed through the gated executor (including non-bash tools that happen to use `exec` internally) are tagged as `tool: 'bash'`. Permission rules targeting other tools (e.g. `glob`, `grep`) will not match. The gate's rule engine (`matchRule`) filters by tool name, so this breaks rule-based gating for any exec-based tool that isn't bash.

**Recommendation:** Pass the actual tool name into `GatedExecutor.exec` (e.g. add a `toolName` parameter), or rename the gate tool to something generic like `exec` and document that rules apply to all exec calls.

---

### 2.4 [med] Mode endpoint returns 404 for invalid mode names (`server/src/app.ts:224–228`)

**Citation:** `app.ts:224–228`:
```ts
const result = entry.agent.queueModeSwitch(body.mode);
if (result.status === 'invalid') {
  return c.json({ error: result.error }, 404);
}
```
An invalid mode name (e.g. `"not-a-mode"`) yields HTTP 404 "Not Found". Semantically 404 implies a missing resource (session), not bad user input. Should be 400.

**Recommendation:** Return 400 for invalid mode names; reserve 404 for the `entry == null` case above.

---

### 2.5 [med] Empty catch in `rule-store.ts` (`permissions/src/rule-store.ts:26–28`)

**Citation:** `rule-store.ts:26–28` — project rules file parse failure is silently swallowed, leaving the store empty. A corrupted `permissions.json` gives the user zero feedback; rules they thought were in force disappear.

**Recommendation:** Log the parse error (with the file path) at `warn` level.

---

### 2.6 [low] `resolvePermission` client method inconsistent error message (`client/src/client.ts:165–170`)

**Citation:** `client.ts:165–170`:
```ts
if (response.status === 409) {
  throw new PermissionAlreadyResolvedError(requestId);
}
if (!response.ok) {
  throw new ChimeraHttpError(response.status, await safeBody(response));
}
```
The generic `ChimeraHttpError` thrown here lacks the `method` and `path` context that the private `json()` helper includes (`"${init?.method ?? 'GET'} ${path} \u2192 ${response.status}"`). Errors from `resolvePermission` are harder to trace in logs.

**Recommendation:** Pass `method` + `path` into the `ChimeraHttpError` constructor for consistency.

---

### 2.7 [low] `hook-bridge.ts` no exhaustiveness guard for new event types

**Citation:** `hook-bridge.ts:26–60` — the `switch (env.type)` has no `default`. If a new `AgentEvent` variant is added (e.g. a new tool lifecycle event that should map to a hook), TypeScript will not flag the omission because `void runner.fire(...)` is not required to be exhaustive. The event silently does nothing.

**Recommendation:** Add a `default` case that logs at `debug` when an unmapped event type is seen, or use a compile-time exhaustive-check helper (`const _exhaustive: never = env`).

---

### 2.8 [low] `client.ts` retry budget logic edge case in `subscribe()`

**Citation:** `client.ts:335` (`retries = 0` reset on successful delivery) — the retry counter resets after every successful event delivery, but if the server stream closes cleanly (line 353) and reconnection also fails immediately, the retry budget is consumed from zero. This is the intended design, but there is no jitter or cap on the exponential backoff (`Math.min(1000 * 2 ** (retries - 1), 5000)`), so a server under load that rejects reconnection attempts will see synchronized retries from all clients.

**Recommendation:** Add random jitter (e.g. +/- 30%) to the backoff delay.

---

### 2.9 [low] `app.ts` DELETE endpoint exposes raw error messages (`server/src/app.ts:102–104`)

**Citation:** `app.ts:102–104`:
```ts
catch (err) {
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
}
```
Raw error messages from the filesystem (`listSessionsOnDisk`) or registry can leak internal paths or implementation details to the HTTP client.

**Recommendation:** Return a generic 500 message to the client and log the internal error server-side.

---

## 3. Test coverage gaps

| Gap | Location | Impact |
|-----|----------|--------|
| No negative HTTP body tests | `server/test/app.test.ts` | All happy-path only; no malformed JSON, wrong types, or missing fields exercised |
| No SSE frame fuzzing | `client/test/` (only `client.test.ts`) | No tests for partial chunks, multi-line `data:`, missing terminators, or injected `id:` fields |
| No hook-bridge leak test | `server/test/hook-bridge.test.ts` | No test verifies `inFlight` is purged on `run_finished` or when `tool_call_result` is missed |
| No permission resolution error-path test | `server/test/app.test.ts` | No test for the 500-vs-409 distinction in the resolve endpoint |

---

## 4. Top actionable fixes (priority order)

1. **Add Zod schemas** to every `await c.req.json()` in `packages/server/src/app.ts`. This is the single highest-impact change.
2. **Narrow the catch** in `app.ts:295–301` to the specific "already resolved" error from core.
3. **Validate SSE envelopes** in `client/src/sse.ts` instead of casting; surface parse errors.
4. **Fix the mode endpoint** 404-for-invalid-mode bug (return 400 instead).
5. **Add debug logging** to all empty-catch blocks in `agent-registry.ts`, `sse.ts`, and `rule-store.ts`.
