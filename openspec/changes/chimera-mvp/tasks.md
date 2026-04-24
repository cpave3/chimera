## 1. Monorepo scaffolding

- [x] 1.1 Create `package.json` at the repo root (private, workspace) and `pnpm-workspace.yaml` declaring `packages/*`.
- [x] 1.2 Add root `tsconfig.base.json` with `strict`, `moduleResolution: "bundler"`, `target: "es2022"`, `skipLibCheck`, and path mappings per the DAG.
- [x] 1.3 Add `biome.json` (formatter + linter) and wire `pnpm fmt` / `pnpm lint` root scripts.
- [x] 1.4 Add a shared `tsup.config.ts` base (ESM + CJS, dts, sourcemaps) that individual packages extend.
- [x] 1.5 Add `vitest.workspace.ts` pulling in every package's own vitest config.
- [x] 1.6 Create `packages/{core,providers,tools,permissions,server,client,tui,cli}/` directories, each with `package.json`, `src/index.ts`, and `tsconfig.json` extending the base.
- [x] 1.7 Install shared dev deps (TypeScript, vitest, @types/node, tsup, biome) at the workspace root.
- [x] 1.8 Verify `pnpm -r build` and `pnpm -r test` run cleanly on an empty scaffold.

## 2. `@chimera/core`

- [x] 2.1 Define `SessionId`, `EventId`, `CallId` (ULID) types and a ULID helper.
- [x] 2.2 Define `Session`, `ModelConfig`, `SandboxMode` (`"off"` only in MVP), `ExecutionTarget`, `ToolCallRecord`, and `RememberScope` types matching `spec.md` §4.2.
- [x] 2.3 Define the full `AgentEvent` discriminated union (subagent variants included for forward compat, even though no subagent tool emits them yet).
- [x] 2.4 Implement `composeSystemPrompt({ cwd })`: fixed role prompt + `AGENTS.md` walk-and-concat with closer files overriding.
- [x] 2.5 Add an extension point (pure function) on `composeSystemPrompt` so a future skills change can append an index without touching core internals.
- [x] 2.6 Implement `persistSession(session)`: write `~/.chimera/sessions/<sessionId>.json` atomically (temp + rename).
- [x] 2.7 Implement `loadSession(sessionId)`: read and validate against the `Session` schema; reset `status` to `"idle"`.
- [x] 2.8 Implement the `Agent` class constructor (validate options, build `session`, wire `AbortController`).
- [x] 2.9 Implement `Agent.run(userMessage)` as an `AsyncIterable<AgentEvent>` driving `streamText` and translating `fullStream` parts to events per §4.4.
- [x] 2.10 Implement the permission-pause latch: when an executor raises a request, emit `permission_request`, set session status, await the latch; on `resolvePermission`, resolve or cancel accordingly.
- [x] 2.11 Implement `Agent.interrupt()` via the wired `AbortController`; ensure in-flight tool calls observe the signal and emit `tool_call_error`.
- [x] 2.12 Implement `Agent.snapshot()` and session persistence on every `step_finished`.
- [x] 2.13 Unit tests: mock `ModelClient` + `Executor`. Cover: single-turn no-tool run; multi-step with tool calls; permission pause/resume; deny returned to model; interrupt mid-bash; max-steps termination; AGENTS.md discovery across a git root.

## 3. `@chimera/providers`

- [x] 3.1 Define `ProvidersConfig`, `Provider`, and `ProviderRegistry` types.
- [x] 3.2 Implement `loadProviders(config)` returning a `ProviderRegistry` backed by a lazy map.
- [x] 3.3 Implement the `anthropic` shape via `@ai-sdk/anthropic`'s `createAnthropic({ baseURL, apiKey })`.
- [x] 3.4 Implement the `openai` shape via `@ai-sdk/openai`'s `createOpenAI({ baseURL, apiKey, compatibility })`; default `compatibility` to `"compatible"`.
- [x] 3.5 Implement `resolve(modelRef)`: split on the first `/` only, handle nested slashes.
- [x] 3.6 Implement `env:VAR_NAME` API-key resolution; throw-on-use when the env var is missing; warn when a plain string is provided; never log the resolved value.
- [x] 3.7 Unit tests: env resolution, unknown providerId error, nested-slash parsing, plain-string warning, that no log line ever contains an api key.
- [x] 3.8 Draft `PROVIDERS.md` at the repo root enumerating known-good shape / vendor combinations as described in `spec.md` §5.4.

## 4. `@chimera/tools`

- [x] 4.1 Define the `Executor`, `ExecOptions`, `ExecResult` interfaces and a `PathEscapeError` class.
- [x] 4.2 Implement `LocalExecutor` with `cwd`-scoped path resolution using `node:path` + a `realpath`-aware escape check; reject absolute / `..`-escaping paths.
- [x] 4.3 Implement `LocalExecutor.exec()` via `child_process.spawn` with timeout → SIGTERM → (2s) SIGKILL progression; populate `timedOut`.
- [x] 4.4 Wire `AbortSignal` from options into the spawned process.
- [x] 4.5 Implement `readFile`, `readFileBytes`, `writeFile` (atomic: temp + rename), `stat`, `cwd`, `target` members.
- [x] 4.6 Define `ToolContext` and `buildTools(ctx)` returning a record with keys `bash`, `read`, `write`, `edit`.
- [x] 4.7 Implement `bash` tool with Zod schema including optional `target`, `timeout_ms`, `reason`; route through `ctx.permissionGate` when `target === "host" && sandboxMode !== "off"` (unreachable in MVP but present).
- [x] 4.8 Implement the destructive-pattern refusal list in `bash` and surface it as a tool error with a helpful message.
- [x] 4.9 Implement `read` with line-number prefixing, 2000-line / 100 KB truncation, and `start_line`/`end_line` support.
- [x] 4.10 Implement `write` (overwrite, create parent dirs, cwd-escape refusal).
- [x] 4.11 Implement `edit` with exact-match, not-found and ambiguous errors, and `replace_all` flag.
- [x] 4.12 Unit tests against temp dirs: each tool happy-path, each tool error path, path-escape, exec timeout, SIGTERM→SIGKILL progression, bash destructive-pattern refusal, read truncation, edit ambiguity.

## 5. `@chimera/permissions`

- [x] 5.1 Define `AutoApproveLevel`, `PermissionRequest`, `PermissionResolution`, `PermissionRule`, and `PermissionGate` types.
- [x] 5.2 Implement `RuleStore` holding session rules in memory and project rules backed by `./.chimera/permissions.json` (atomic write-through, `version: 1`).
- [x] 5.3 Implement `matchRules(req, rules)`: compare `tool` / `target`, match `pattern` via exact or `minimatch`; apply deny-wins / longer-pattern-wins / most-recent tie-breakers.
- [x] 5.4 Implement `PermissionGate.check(req)` returning the implied resolution or `null`.
- [x] 5.5 Implement `PermissionGate.request(req)` that emits (via a callback the core wires up) `permission_request` and returns a promise resolved by `resolvePermission`.
- [x] 5.6 Implement `PermissionGate.addRule(rule, persist)` touching only the requested scope.
- [x] 5.7 Implement `GatedExecutor` wrapping an inner `Executor`: gate `exec()` only; pass through `readFile` / `writeFile` / `stat`.
- [x] 5.8 Unit tests: rule matching edge cases (exact vs glob, deny-vs-allow, longer-pattern), session vs project persistence, `.chimera/` directory creation on first write, atomic rewrite, GatedExecutor auto-approve level mapping, pause + release latch semantics.

## 6. `@chimera/server`

- [x] 6.1 Add Hono as a dep; scaffold an `app = new Hono()` factory that takes an `AgentRegistry` handle.
- [x] 6.2 Implement session CRUD: POST/GET/GET-by-id/DELETE on `/v1/sessions`; each creates/reads `Agent` instances.
- [x] 6.3 Implement `POST /v1/sessions/:id/messages` queueing a run, responding `202`; return `409` if a run is in progress.
- [x] 6.4 Implement `POST /v1/sessions/:id/interrupt` delegating to `Agent.interrupt()` and responding `204` (idempotent).
- [x] 6.5 Implement the permission routes: `POST /permissions/:requestId`, `POST /permissions/rules`, `GET /permissions/rules`, `DELETE /permissions/rules/:idx`.
- [x] 6.6 Implement the SSE `/v1/sessions/:id/events` endpoint with a per-session ring buffer (≥ 1000 events) keyed by `eventId`; support `?since=<eventId>` replay; format `event: agent_event` + `id:` + `data:`.
- [x] 6.7 Implement `GET /v1/instance` (pid, cwd, version, sandboxMode, parentId?) and `GET /healthz`.
- [x] 6.8 Implement server-start: bind `127.0.0.1:0` by default, refuse non-loopback bind unless `--host` explicitly supplied (then log a warning); return the bound `{ url, port }` synchronously to the CLI.
- [x] 6.9 Integration tests with Hono test client: full session create → message → events → interrupt → permission resolve cycle; SSE resume with `since`; rule CRUD; duplicate-resolve 409.

## 7. `@chimera/client`

- [x] 7.1 Implement `ChimeraClient` constructor accepting `{ baseUrl, fetch? }`; expose all methods from the SDK spec.
- [x] 7.2 Implement session CRUD methods as thin fetch wrappers; surface non-2xx as typed errors.
- [x] 7.3 Implement `send(sessionId, message)` as an `AsyncIterable`: POST message, open SSE, yield parsed `AgentEvent`s, stop after `run_finished`.
- [x] 7.4 Implement `subscribe(sessionId, { sinceEventId })` with resume support.
- [x] 7.5 Implement `resolvePermission` surfacing `409` as `PermissionAlreadyResolvedError`.
- [x] 7.6 Implement `listRules` / `addRule` / `removeRule` methods.
- [x] 7.7 Implement transient-error auto-reconnect (3 retries, exponential backoff) using the last observed `eventId` as `sinceEventId`.
- [x] 7.8 Implement the permission-request timeout synth-event (default 5 min, configurable).
- [x] 7.9 Integration tests: spin up a real `@chimera/server` on an ephemeral port and exercise the full surface including mid-stream reconnect.

## 8. `@chimera/cli`

- [x] 8.1 Add a CLI parser (e.g. `commander` or `citty`) and wire top-level subcommands.
- [x] 8.2 Implement config loading from `~/.chimera/config.json` with env var overrides.
- [x] 8.3 Implement `chimera serve`: start server, write `~/.chimera/instances/<pid>.json`, handle SIGINT/SIGTERM for clean shutdown (delete lockfile, close sessions).
- [x] 8.4 Implement `chimera run`: spawn same-process server, create session, stream events, render to stdout (or NDJSON with `--json`), map `run_finished.reason` to exit codes per §§15.1 / 20.
- [x] 8.5 Implement `chimera` (interactive): spawn server + mount TUI in the same process; in-memory `fetch` transport for the client.
- [x] 8.6 Implement `chimera attach <id|url>`: resolve id via lockfile scan or use URL directly; mount TUI.
- [x] 8.7 Implement `chimera ls`: scan `~/.chimera/instances/`, probe PID liveness, delete stale entries, print a stable table.
- [x] 8.8 Implement `chimera sessions` / `chimera sessions rm <id>` over `~/.chimera/sessions/`.
- [x] 8.9 Reject MVP-unsupported flags (`--sandbox*`, subagent flags) with an actionable error.
- [x] 8.10 Implement `chimera serve --machine-handshake`: write the JSON line atomically on ready (before accepting requests is fine; stdout flush guaranteed).
- [x] 8.11 CLI smoke tests: `chimera run "…"` with a stub provider + `--json`; exit codes for stop / error / max_steps / interrupted; `chimera ls` cleanup; sandbox-flag rejection.

## 9. `@chimera/tui`

- [x] 9.1 Scaffold the Ink app with a root component that takes `ChimeraClient` + `sessionId` as props.
- [x] 9.2 Implement the header / scrollback / input / footer layout components.
- [x] 9.3 Subscribe to `client.subscribe(sessionId)` and render events into the scrollback state machine.
- [x] 9.4 Implement the input box (controlled Ink component): Enter submits; Shift+Enter newline; history navigation on Up/Down when empty; Tab autocomplete for `/`-prefixed input.
- [x] 9.5 Implement Ctrl+C interrupt-vs-exit behavior (2-second window) and Ctrl+D exit.
- [x] 9.6 Implement built-in slash commands (`/help`, `/clear`, `/new`, `/sessions`, `/exit`, `/model`, `/rules`). Unknown slash → inline "did you mean" hint.
- [x] 9.7 Implement the permission modal with all six actions; wire `g` sub-prompt for pattern editing and scope selection; call `client.addRule` + `client.resolvePermission` in the right order.
- [x] 9.8 Implement `NO_COLOR` respect by guarding every chalk/Ink color prop behind a shared theme.
- [x] 9.9 Tool-call rendering: collapsible rows, `[host]` badge, ~20-line preview for bash with expand affordance.
- [x] 9.10 Snapshot tests via `ink-testing-library` covering: header render, streamed assistant text, tool-call row, permission modal, unknown-slash hint.

## 10. Cross-cutting polish

- [x] 10.1 Structured JSON-line logging to `~/.chimera/logs/<date>.log` with key-truncation (~4 KB) and redaction of any `apiKey` fields; tee to stderr when `--verbose`.
- [x] 10.2 Model-error retry / backoff: 3 retries on rate-limit / transient network / auth-transient errors, then surface `run_finished { reason: "error" }`.
- [x] 10.3 Tool errors always caught and surfaced as `tool_call_error` (never crash the loop).
- [x] 10.4 Ship a default `.gitignore` template recommendation under `docs/` covering `.chimera/sessions/` and `.chimera/logs/` but NOT `.chimera/permissions.json`.
- [x] 10.5 Write a short `README.md` at the repo root: install, run, configure a provider, example interactive and `run` sessions.

## 11. End-to-end verification

- [x] 11.1 E2E: `chimera run "echo hello"` with a stub model that deterministically issues one `bash` tool call; assert stdout content, exit 0, session file on disk, lockfile cleaned up.
- [x] 11.2 E2E: interactive `chimera` session against the stub model; confirm TUI renders, interrupt works, permission modal flow.
- [x] 11.3 E2E: `chimera serve` + `chimera attach <id>` in two processes; confirm attach sees the full event stream (via SSE `?since`).
- [x] 11.4 Record a short asciinema or plain-text session transcript in `docs/` demonstrating MVP capability.
