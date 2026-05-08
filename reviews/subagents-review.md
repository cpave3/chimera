# Subagent system code-quality review

Severity: `[crit]` / `[high]` / `[med]` / `[low]`. Every item cites `file:line`.

---

## 1. Drive-loop duplication (unchanged since prior review)

**[high]** `packages/subagents/src/spawn-child.ts:213-283` and `packages/subagents/src/spawn-in-process.ts:57-127`

`driveChild` and `driveInProcess` are ~70-line near-identical copies of the same event-extraction, abort-cascade, timeout, and reason-mapping logic.

Shared verbatim:
- Local accumulator variables (`finalText`, `reason`, `errorMessage`, `steps`, `toolCallsCount`, `timedOut`).
- `AbortController` wiring for parent-signal propagation (`sendController`, `onParentAbort`).
- `setTimeout`/`clearTimeout` timeout path with the same `timedOut` flag.
- Identical `for await … if/else if` chain over event types (`assistant_text_done`, `tool_call_start`, `step_finished`, `run_finished`).
- Identical `catch` classification (`timedOut` → `timeout`, `signal.aborted` → `interrupted`, else → `error`).
- Identical final `if (timedOut) reason = 'timeout';` override.

Remaining differences:
- `driveInProcess` calls `handle.interrupt()` on parent abort and on timeout; `driveChild` does not — the caller (`spawn-tool.ts:257-260`) must manage it separately.
- `driveChild` needs `ev as AgentEvent` because `ChimeraClient.send` is loosely typed.

**Recommendation:** Extract a `SubagentDriver` interface so the two paths share a single `async function drive(sendFn, interruptFn, ...)`. Both `ChildHandle` and `InProcessHandle` can satisfy it.

---

## 2. `spawn-child.ts` stderr buffer — O(n²) string concatenation

**[high]** `packages/subagents/src/spawn-child.ts:116-122`

```ts
let stderrBuf = '';
proc.stderr.on('data', (d: Buffer) => {
  stderrBuf += d.toString('utf8');
  if (stderrBuf.length > 4096) {
    stderrBuf = stderrBuf.slice(-4096);
  }
});
```

Each `'data'` event allocates a new string whose length is the sum of all prior chunks. On a chatty child (crashing server with stack traces, verbose `--debug` build) this is O(n²) in total bytes emitted. The same pattern appears in `e2e-spawn.test.ts:82-84` and `:149-151`.

**Recommendation:** Accumulate chunks in a `string[]` and join once on error, or keep a bounded ring-buffer of the last N chunks.

---

## 3. NEW `agents/` code (post-26 April)

### 3a. Third copy of frontmatter-aware Markdown discovery

**[med]** `packages/subagents/src/agents/discover.ts` and `packages/subagents/src/agents/frontmatter.ts`

`commands/src/discover.ts` and `skills/src/discover.ts` are already parallel frontmatter-aware Markdown walkers. `agents/` adds a third. The inline comment in `frontmatter.ts:12-13` admits it: "Forked from @chimera/skills ..."

**Recommendation:** Extract a shared `DiscoveryWalker` (or `@chimera/discovery` package) before a fourth copy lands.

### 3b. `ReloadingAgentRegistry` — missing `/reload` fallback for post-startup tiers

**[med]** `packages/subagents/src/agents/reloading.ts:82-92`

`installWatchers` silently swallows `fs.watch` throws for missing tier directories. The JSDoc notes: "Tier dirs that do not exist at startup are not picked up until `reload()` is invoked manually." Unlike `ReloadingCommandRegistry`, there is **no `/reload` command or endpoint** for agents. If a user creates `~/.chimera/agents/` while Chimera is running, the registry never sees it until restart.

**Recommendation:** Add a `/reload` hook or expose `reload()` on the registry so the TUI can call it when a new tier directory appears.

### 3c. `ReloadingAgentRegistry` — `onFsEvent` filename filtering is fragile

**[low]** `packages/subagents/src/agents/reloading.ts:95-99`

On Linux with recursive `fs.watch`, a file move/rename inside a subdirectory may emit the directory name as `filename`, not the file name. This causes unnecessary reloads (harmless) but means `.md` renames can be missed.

**Recommendation:** Accept extra reloads as harmless, or resolve each event to an actual path before filtering.

### 3d. `parseFrontmatter` — no tests for block scalars, quoted values, or malformed fences

**[med]** `packages/subagents/src/agents/frontmatter.ts`

`agents-discover.test.ts` never covers block scalars (`|` and `>` at lines 44-60), quoted-value unquoting (lines 102-111), or malformed fence edge cases.

### 3e. `parseFrontmatter` — silently swallows malformed / continuation lines

**[med]** `packages/subagents/src/agents/frontmatter.ts:38-39`

Lines without a colon are silently ignored. A multi-line unquoted value without `|` will have continuation lines dropped:

```yaml
---
description: This is a long
  description that spans lines
---
```

The second line is skipped, producing a truncated description.

**Recommendation:** Either support line continuations or emit a warning when a fence-internal line is skipped.

---

## 4. `spawn-tool.ts` — schema declared but not defended at execution boundary

**[high]** `packages/subagents/src/spawn-tool.ts:19-61, 84`

`ARGS_SCHEMA` is declared and passed to `defineTool` as `inputSchema`. The AI SDK validates the schema before calling `execute`, but the function itself does not run `ARGS_SCHEMA.parse(args)` at its entry point. Tests exercise `execute` directly (bypassing the AI SDK):

```ts
const tool = buildSpawnAgentTool(ctx).tool as unknown as { execute: (a: any, c: any) => Promise<any> };
await tool.execute({ prompt: 'go', purpose: 'p', in_process: true }, …);
```

Any direct caller receives unvalidated `unknown` args that fail deep inside with confusing messages.

**Recommendation:** Add `const validated = ARGS_SCHEMA.parse(args);` at the top of `execute` and use `validated` thereafter.

---

## 5. `spawn-tool.ts` — unsafe cast for `toolCallId`

**[med]** `packages/subagents/src/spawn-tool.ts:86`

```ts
const aiSdkToolCallId = (opts as { toolCallId?: string }).toolCallId;
```

`opts` is typed as `{ abortSignal?: AbortSignal }` by `defineTool`. The AI SDK passes `toolCallId`, but TypeScript does not know it.

**Recommendation:** Update `DefineToolOptions` (or create a `ChimeraToolExecuteOptions` type) to include `toolCallId?: string` so the cast is unnecessary.

---

## 6. `spawn-tool.ts` — inconsistent interrupt handling between child and in-process paths

**[med]** `packages/subagents/src/spawn-tool.ts:163-230` vs `:233-300`

In the **in-process** path, `driveInProcess` calls `handle.interrupt()` when the parent signal fires or the timer expires. In the **child-process** path, `driveChild` does NOT call `interruptChild` internally. Instead, `spawn-tool.ts:257-260` registers a separate listener:

```ts
const onAbort = () => { if (handle) void interruptChild(handle).catch(() => {}); };
effectiveSignal.addEventListener('abort', onAbort, { once: true });
```

This split is fragile: if a future refactor removes the `onAbort` listener but keeps `driveChild`, interrupt cascade breaks silently.

**Recommendation:** Unify interrupt into the shared `SubagentDriver` interface so the caller does not need to know which transport is in use.

---

## 7. `spawn-tool.ts` — swallowed error in `awaitCallId` fallback

**[low]** `packages/subagents/src/spawn-tool.ts:99-104`

```ts
try {
  parentCallId = await ctx.awaitCallId(aiSdkToolCallId, ctx.parentAbortSignal);
} catch {
  parentCallId = newCallId();
}
```

Any rejection (not just AbortError) is silently swallowed and replaced with a synthetic call ID.

**Recommendation:** Catch only `AbortError` or log the error at debug level.

---

## 8. Handshake logic

### 8a. `readHandshakeLine` — O(n²) string buffer

**[low]** `packages/subagents/src/handshake.ts:50-51`

`buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');` — same allocation pattern as §2, though impact is minor because handshake is typically <1 KB.

### 8b. `readHandshakeLine` — `isHandshakeMessage` shallow validation

**[low]** `packages/subagents/src/handshake.ts:97-105`

The validator checks types but not that `url` is a valid HTTP(S) URL or that `sessionId` is non-empty. A child emitting `{"ready":true,"url":"oops","sessionId":"","pid":0}` would pass and then fail later with a cryptic `fetch` error.

**Recommendation:** Add `url.startsWith('http')` and `sessionId.length > 0` guards.

---

## 9. Subagent argv handling

### 9a. `buildChildArgv` — no validation of `tools` array contents

**[low]** `packages/subagents/src/spawn-child.ts:88-90`

`args.tools.join(',')` assumes no tool name contains a comma.

**Recommendation:** Validate (or reject) tool names containing commas, or switch to repeated `--tool <name>` flags.

### 9b. `buildChildArgv` — `chimeraBinArgs` not validated

**[low]** `packages/subagents/src/spawn-child.ts:57`

`...(args.chimeraBinArgs ?? [])` spreads user-provided strings directly into argv.

**Recommendation:** Validate that `chimeraBinArgs` items are non-empty strings.

---

## 10. Test coverage gaps

### 10a. Child-process path is entirely uncovered by unit tests

**[high]** `packages/subagents/src/spawn-tool.ts:233-300`

All tests in `spawn-tool.test.ts` pass `in_process: true`. The child-process branch (real `spawnChimeraChild`, `driveChild`, `teardownChild`) has zero unit-test coverage. Bugs in that branch are only testable via the gated E2E suite, which itself only exercises handshake and flag parsing.

**Recommendation:** Add unit tests that mock `spawnChimeraChild` (inject a fake `ChildHandle`) to exercise the child-process branch, including successful flow, handshake failure, and parent abort cascade.

### 10b. `parallel-interrupt.test.ts` only covers in-process

**[med]** `packages/subagents/test/parallel-interrupt.test.ts`

Parallel-interrupt tests two concurrent in-process children but never tests the child-process equivalent. Child-process parallel spawning is the production CLI path.

**Recommendation:** Add a parallel-interrupt test with mocked `ChildHandle` to verify `interruptChild` is called for both children when the shared parent signal aborts.

### 10c. No tests for `ReloadingAgentRegistry`

**[med]** `packages/subagents/src/agents/reloading.ts`

The watch/debounce/reload logic, `onChange` notifications, `close()` cleanup, and `installWatchers` error handling are entirely untested.

**Recommendation:** Add tests using temp directories + manual `fs.watch` simulation to verify `.md` creation triggers reload, non-`.md` changes are ignored, debounce coalesces rapid events, and `close()` stops watchers and timers.

### 10d. No tests for `spawnChimeraChild` failure paths

**[med]** `packages/subagents/src/spawn-child.ts:94-185`

Uncovered branches: handshake timeout, early child exit during handshake, health-check failure, missing stdio pipes, and `promptDir` cleanup on handshake failure.

### 10e. No tests for `teardownChild` / `terminateProc`

**[med]** `packages/subagents/src/spawn-child.ts:289-354`

`teardownChild` and `terminateProc` (SIGTERM grace → SIGKILL grace → forced resolve) are untested. The nested setTimeout logic is easy to regress.

### 10f. No tests for `agents/discover.ts` ancestor / git-root logic

**[low]** `packages/subagents/src/agents/discover.ts:42-59`

`ancestorsBetween` and `isGitRoot` are not exercised. Tests only cover project and user tiers.

---

## Top 5 recommendations

1. **Extract a shared `SubagentDriver` interface** to unify `driveChild` and `driveInProcess`. This removes ~70 lines of duplication and fixes the inconsistent interrupt-handling split (the in-process path interrupts internally; the child-process path relies on a caller-side listener).
2. **Replace stderr `+=` concatenation** in `spawn-child.ts:116-122` with a bounded array buffer. On a chatty child this is a real performance regression.
3. **Run `ARGS_SCHEMA.parse(args)` at the top of `spawn-tool.ts` execute.** Direct callers (including all tests) currently bypass validation.
4. **Add unit tests for the child-process branch of `spawn-tool.ts`.** Mock `ChildHandle` and exercise spawn → drive → teardown, handshake failure, and parent abort. Today this branch is completely uncovered.
5. **Create a shared `DiscoveryWalker`** to replace the third copy of frontmatter-aware tier-directory walking in `agents/`. The duplication with `commands/` and `skills/` will compound with every new asset type.
