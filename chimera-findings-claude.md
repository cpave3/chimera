# Chimera code-quality review

Severity tags: `[crit]` / `[high]` / `[med]` / `[low]`. Every finding cites a
verified `file:line`. Items already documented as intentional in `AGENTS.md`
(e.g. `tsc -b` JSX noise, `__resetContextWindowWarnings` for tests) are
excluded.

## 1. Complexity hot-spots

- `[high]` **`packages/tui/src/App.tsx` (1449 lines).** One component owns UI
  state, slash-command dispatch, permission resolution, subagent routing, and
  the static/streaming entry split. Concrete extractions:
  - `handleSlash` (≈L519–1011) → its own command-dispatcher module.
  - `onResolve` permission/subagent logic (L1013–1033) → `permission-resolver.ts`.
  - Entry split & subagent grouping (L1047–1076) → `scrollback-split.ts`.
- `[high]` **`packages/core/src/agent.ts` `runInternal` (≈L335–643).** A
  ~300-line async function with a deeply nested
  `for await … switch (part.type)` over the SDK stream. Extract the
  stream-event loop into a `StreamProcessor`; pull usage reconciliation
  (L546–554) into a helper.
- `[high]` **`packages/sandbox/src/docker-executor.ts` (434 lines).** Image
  build/inspect, container start/stop, exec, and file ops share one class.
  Split into `DockerImageManager` + `DockerContainerManager`. `buildRunArgs`
  (L192–244) is a tangled string-array builder — replace with a small builder.
- `[med]` **`packages/tui/src/scrollback.ts` (476 lines).** Three parallel
  maps (`toolsByCallId`, `subagentParents`, `subagentToolsByCallId`, L31–41)
  hold overlapping state — consolidate into a `ToolRegistry`. The
  `subagent_event` handler (L297–374) wants its three sub-cases extracted.
- `[med]` **Subagent drive duplication.** `driveChild` (`spawn-child.ts`
  L180–249) and `driveInProcess` (`spawn-in-process.ts` L55–125) implement
  the same event-extraction loop twice. Extract a `SubagentDriver` interface.
- `[med]` **`packages/cli/src/program.ts` (434 lines).**
  `applySubagentOptions` / `applySandboxOptions` (L20–51) mutate a passed-in
  `Command` — flatter to take a config object. Per-subcommand action bodies
  (L80–182) overlap with `cli/src/commands/*.ts`.
- `[med]` **`packages/cli/src/factory.ts` `build()` (from L82).** Long
  procedural setup that wires providers, sandbox, gates, and persistence
  inline. Group construction phases into named helpers.

## 2. Boundary validation (the highest-impact gap)

Zod is already a dep and is used inside tool schemas — but **not** at the
HTTP boundary.

- `[high]` **`packages/server/src/app.ts` has no schema validation on JSON
  bodies.** The endpoints below trust whatever shape arrives:
  - `POST /v1/sessions` (L50–60) reads `body.cwd`, `body.model`,
    `body.sandboxMode`, `body.sessionId` blindly.
  - `POST /v1/sessions/:id/messages` (L184–192) does
    `String(body.content ?? '')` — sends literal `"undefined"` /
    `"[object Object]"` to the model on bad input.
  - The fork, resume, and `permissions/:requestId/resolve` endpoints follow
    the same pattern.

  Fix: add a Zod schema per endpoint, reject with 400 on parse failure.
- `[med]` **`packages/client/src/sse.ts` L47–70.**
  `JSON.parse(data) as AgentEventEnvelope` casts unvalidated objects. A
  truncated frame produces malformed events that propagate to consumers, and
  the surrounding `catch` swallows parse failures and returns `null`
  silently. Validate envelope shape; log the parse error at debug.
- `[med]` **`packages/subagents/src/spawn-tool.ts`.** `ARGS_SCHEMA` (L17–53)
  is declared and registered with the tool definition, but `execute`
  operates on raw `unknown` args. Run the schema at execution time before
  dereferencing.

## 3. Type-safety gaps

- `[high]` **`packages/tui/src/App.tsx:1028`** — `remember as any` on
  `resolvePermission`. `remember` is already a clean discriminated union;
  the cast hides downstream type drift.
- `[med]` **`packages/tools/src/define.ts:23`** —
  `tool as unknown as (cfg: unknown) => unknown` wrapping the AI-SDK tool
  factory. Replace with a typed wrapper.
- `[med]` **`packages/client/src/client.ts:88`** —
  `return undefined as unknown as T` for 204 responses. Encode 204 in the
  type via overloads instead of double-casting.
- `[low]` **`packages/core/src/agent.ts:413,443,476`** — extracts
  `args` / `output` via `as { input?: unknown }` etc. instead of an
  SDK-typed view. Tolerable, but a single typed adapter would be safer.

## 4. Concurrency & resource issues

- `[high]` **`packages/subagents/src/spawn-child.ts:80–92`.** The stderr
  buffer uses repeated string concatenation (`stderrBuf += d.toString(...)`)
  and only truncates the tail per chunk. On a chatty child this is O(n²)
  allocation and GC churn. Use a bounded array with one final `.join('')`,
  or a ring buffer.
- `[med]` **`packages/tui/src/App.tsx` SSE subscribe `useEffect`
  (L295–313).** Aborts on unmount, but on the error branch it writes to
  scrollback and exits the async IIFE without ensuring the previous
  subscription has fully closed before a re-mount. Add a
  `controller.signal.aborted`-gated finally block.
- `[med]` **`packages/server/src/app.ts:270–295` SSE handler.**
  `entry.bus.subscribe((env) => void stream.writeSSE({...}))` — after
  `c.req.raw.signal` aborts, in-flight publishes can still call `writeSSE`
  on a closed stream. Wrap the subscriber callback in an `aborted`-check
  or unsubscribe synchronously on abort.
- `[med]` **`packages/sandbox/src/docker-runner.ts:73–80`.**
  `try { child.kill('SIGTERM'); } catch {}` swallows ESRCH (process gone,
  fine) and EPERM (couldn't terminate, real problem) identically. Log EPERM
  at debug or surface it.

## 5. Error-handling smells

The empty-catch idiom has spread across the codebase. None individually is
critical; the pattern is.

- `packages/sandbox/src/docker-runner.ts:75,79` — kill failures.
- `packages/client/src/sse.ts:34–42` — reader cancel/release.
- `packages/server/src/app.ts:259–261` — catches **all** errors from
  `resolvePermission` and reports them as 409 "already resolved", masking
  other failure modes (e.g., state corruption). Catch the specific
  "already-resolved" condition only.
- `packages/cli/src/factory.ts:134–138` — silent failure on session
  metadata write means the session won't be listed by `chimera sessions`.
- `packages/server/src/agent-registry.ts:161–165` — silent on `activeRun`
  rejection during dispose; the comment justifies it but at least call
  `core.logger.debug`.

## 6. Permissions / security surface

- `[med]` **`packages/tools/src/bash.ts:7–13` destructive-pattern list is a
  speed bump, not a boundary.** `$(rm -rf /)`, `dd if=/dev/zero of=/etc/...`,
  command substitutions, and here-docs all bypass it. The real safety net
  is the permission gate; either delete this list (so it doesn't read as
  defense-in-depth that isn't there) or document it as advisory and stop
  growing it.
- `[med]` **`packages/sandbox/src/docker-executor.ts:280–285`.**
  `--user ${this.hostUid}:${this.hostGid}` joined into `docker exec` argv
  with no validation that the IDs are non-negative integers. Validate at
  construction (line 57: `resolveHostId`).
- `[low]` **`toContainerPath` (`docker-executor.ts:394–407`)** lets absolute
  paths pass through to the container. Intentional, but worth a one-line
  comment so future readers don't tighten it accidentally and break tools
  that read `/etc`-relative paths the user authorised.

## 7. Duplication

- See §1 for spawn-child vs spawn-in-process drive loops.
- **`packages/commands/src/discover.ts` and `packages/skills/src/discover.ts`**
  are parallel frontmatter-aware Markdown walkers. Subagents will likely
  add a third — extract a shared `DiscoveryWalker` before that lands.

## 8. Test coverage gaps (only the risky ones)

The packages have test files; these are the *branches* that aren't covered:

- `[med]` **No SSE-frame fuzzing.** `client/src/sse.ts` parses partial
  chunks, multi-line `data:`, and missing terminators with no tests for
  those branches. Failure mode: malformed frames silently drop events.
- `[med]` **No HTTP-validation negative cases.** `server/test/app.test.ts`
  exercises happy paths; the bodies described in §2 have no negative-input
  coverage. Adding Zod will give these for free.
- `[med]` **`docker-executor.ts`'s `toContainerPath` and `shellQuote`
  (L394–419)** are pure functions doing security-relevant work; today they
  are only exercised via the gated Docker E2E suite.
- `[low]` **`core/src/event-queue.ts`** — no test; producer/consumer races
  would benefit from a stress test.

## Top 5 actionable fixes

1. Add Zod schemas to every `await c.req.json()` in
   `packages/server/src/app.ts`. Quick, blocks a real class of bug.
2. Drop `as any` on the permission `remember` argument in
   `packages/tui/src/App.tsx:1028` (chase the type to
   `client.resolvePermission` — it should already be a union).
3. Extract a shared `SubagentDriver` for child + in-process spawn.
4. Replace the stderr `+=` concat in `spawn-child.ts` with a bounded
   buffer.
5. Carve `handleSlash` out of `App.tsx` — that single move cuts the file
   by ~500 lines and makes everything else easier.

## What I deliberately did *not* flag

- `tsc -b` JSX noise / leaked `*.js` artefacts in `src/` —
  `AGENTS.md` documents this as known.
- `__resetContextWindowWarnings` in `providers/src/context-window.ts` —
  intentional, exported for tests, documented.
- Biome version, missing pre-commit hooks, missing TypeDoc/architecture
  diagrams, missing per-package READMEs — process polish, not code-quality
  defects.
- `SECURITY.md` exists at the repo root; not a gap.
- LOC ratios as a stand-in for coverage. They aren't.
