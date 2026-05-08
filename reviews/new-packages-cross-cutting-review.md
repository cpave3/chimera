# Code-quality review: `modes`, `hooks`, `providers` (new / changed since 2026-04-26)

Severity: `[crit]` / `[high]` / `[med]` / `[low]`. Every item cites a verified `file:line`.

---

## 1. `packages/modes/` — NEW package

### 1.1 Discovery (discover.ts)

- `[med]` **`discover.ts:144`** — `name !== stem` skip logic rejects files whose `name` frontmatter differs from the filename. This is stricter than `commands` (which derives the name from the path) and `subagents` (which falls back to the file stem when `name` is absent). The inconsistency means a user can copy a subagent definition into `.chimera/modes/` and it silently disappears. Recommend documenting this in the user-facing docs or aligning with subagents (allow mismatch with a warning).

- `[low]` **`discover.ts:152–156`** — Invalid `color` frontmatter is warned and nulled, then `colorFor(name, rawColor)` is called with `rawColor = undefined`. But `parseFrontmatter` already extracted `fm.color` which is the raw string. The variable is shadowed (`rawColor` vs `fm.color`), which is harmless but confusing.

- `[low]` **`discover.ts:52–72`** — `ancestorsBetween` logic diverges from `commands/src/discover.ts:54–72`. In `commands`, `stopAt` is pushed *before* the break check; in `modes` it is not. The `modes` comment says "Stop at userHome without including it", but `commands` includes it. Same tier concept, different boundary semantics. Pick one.

- `[low]` **`discover.ts:19–45`** — `buildTiers` is a near-verbatim copy of `commands/src/discover.ts:12–45`, `skills/src/discover.ts:17–39`, and `subagents/src/agents/discover.ts:17–39`. See §6 (Cross-cutting duplication).

### 1.2 Frontmatter parser (frontmatter.ts)

- `[med]` **`frontmatter.ts:23–95`** — The custom YAML-ish parser does **not** support block scalars (`|`, `>`), which `skills` and `subagents` frontmatter parsers do support. A mode author who copies a multi-line description from a skill file will get the literal `|` as the description value. Inconsistent UX across the three frontmatter-aware asset types.

- `[low]` **`frontmatter.ts:71–72`** — `tools` inline-array parsing uses `raw.slice(1, -1).trim()` then `inner.split(',')`. This fails on quoted array elements that contain commas (`tools: ["a, b", c]`). The parser is intentionally narrow, but this specific case (quoted comma) is easy to mishandle. Document the limitation or use a tiny regex split.

### 1.3 System-prompt composition (system-prompt.ts)

- `[low]` **`system-prompt.ts:10–12`** — `renderModeBlock` emits `# Current mode: <name>\n\n<body>`. No escaping of `mode.name` — if a malicious mode file sets `name: foo\n# Overridden`, the injected markdown heading confuses the prompt. Sanitize or restrict `name` to non-newline characters at parse time.

### 1.4 Registry (registry.ts)

- `[low]` **`registry.ts:8–13`** — `InMemoryModeRegistry` sorts and copies arrays in the constructor (`[...modes].sort(...)`) but `all()` returns `[...this.byName.values()]` which is already insertion-ordered because the map was constructed in sorted order. The sort at constructor time is correct, but `paths()` also copies again (`new Set(this._paths)`). The defensive copies are fine; the duplication is just noise.

### 1.5 Color (color.ts)

- `[low]` **`color.ts:45–55`** — `fnv1a32` uses `new TextEncoder().encode(input)` on every call. `TextEncoder` construction is cheap but unnecessary — hoist it to module scope.

### 1.6 Types (types.ts)

- `[low]` **`types.ts:66–75`** — `ModeValidationError` is declared but never thrown or caught anywhere in `packages/modes/`. Dead code until something wires it up.

### 1.7 Test coverage

- `[med]` **`test/load.test.ts`** — No test for the `builtinModesDir` resolution path (lines 89–99 of discover.ts). If the builtin directory is moved or the package is bundled differently, runtime discovery of builtins silently fails.

- `[med]` **`test/load.test.ts`** — No tests for `collision` entries returned by `discover` — the `collisions` array is populated but never asserted.

---

## 2. `packages/hooks/` — NEW package

### 2.1 Discovery (discovery.ts)

- `[low]` **`discovery.ts:33–45`** — `discover` is async and re-scans the filesystem on every `fire()` call. For hot events like `PostToolUse` (after every tool call) this is repeated `readdir`/`stat` traffic. Acceptable for the current design, but worth caching with `fs.watch` reload if hook directories grow.

- `[low]` **`discovery.ts:47–69`** — `listExecutables` checks `info.mode & 0o111` for executability. On Windows this is a no-op (all files report executable bits). The package is Node-only, but a comment acknowledging the platform limitation would help future porters.

### 2.2 Runner (runner.ts)

- `[med]` **`runner.ts:92–99`** — `buildEnv` spreads `process.env` directly. In tests this leaks the real environment into spawned hooks. The `DefaultHookRunnerOptions` interface accepts `cwd` and `sessionId` but not a custom env base. Consider adding `env?: NodeJS.ProcessEnv` to the options so tests can run in a scrubbed environment.

- `[med]` **`runner.ts:131–146`** — Timeout kill logic catches ALL errors from `process.kill(-pid, 'SIGKILL')` and the child.kill fallback. `EPERM` (permission denied) is silently swallowed alongside `ESRCH` (already dead). At least log `EPERM` at warn.

- `[low]` **`runner.ts:62–79`** — Pre-event blocking continues running remaining scripts after a block is recorded, but `blockResult` is only captured for the *first* script that exits 2. If a later script also exits 2, its stderr (which might contain a more specific reason) is lost. Document "first blocker wins" or collect all blockers.

- `[low]` **`runner.ts:148–155, 164–180`** — Both `error` and `close` handlers can settle the promise. The `settled` guard prevents double-resolution, but if an error fires *after* the close event has already resolved, the error handler still logs a warn — which is fine, but produces a spurious log line.

- `[low]` **`runner.ts:186–196`** — `child.stdin?.write(json, (err) => { ... })` + `child.stdin?.end()` is race-prone. If the process exits before `.end()` is called, the `error` handler on line 185 swallows the EPIPE. This is intentional (documented in the comment), but worth a unit test to prevent regression.

### 2.3 Types (types.ts)

- `[low]` **`types.ts:61–78`** — `FirePayload` is a discriminated union but duplicates all payload fields except `session_id` and `cwd`. The duplication is by design (the runner injects those), but if a new event type is added the compiler won't enforce that both `HookPayload` and `FirePayload` are updated. A mapped type or generic could keep them in sync.

### 2.4 Integration with server hook-bridge

- `[med]` **`packages/server/src/hook-bridge.ts:23–68`** — The `meta?.name ?? 'unknown'` fallback on lines 39 and 50 means a `tool_call_result` / `tool_call_error` that arrives without a matching `tool_call_start` (e.g. due to a bus replay or race) silently reports `tool_name: 'unknown'`. This makes hook audit logs unreliable. Consider warning when `meta` is absent.

- `[low]` **`packages/server/src/hook-bridge.ts:63–68`** — `toRecord` coerces non-object args to `{}`. If a tool receives a string or number argument, the hook payload loses it entirely. Document this limitation in the hook payload schema docs.

- `[med]` **`packages/server/test/hook-integration.test.ts:139–180`** — `SessionEnd` test uses a real filesystem and `await readFile(counter, 'utf8')` to assert the hook fired. This is an integration test, not a unit test — a unit test using a mocked `HookRunner` would be faster. The current test is fine but slow for CI.

### 2.5 Test coverage

- `[med]` **`test/runner.test.ts`** — No test for the `child.on('error')` path (spawn failure, line 122 of runner.ts). The missing-interpreter test exercises a different path (interpreter not found, which exits with code 126/127 rather than spawn error).

- `[med]` **`test/runner.test.ts`** — No test for mixed global+project script ordering (global scripts should appear before project scripts in the combined execution list). The `discover` test checks `result.global` and `result.project` separately but `runner.fire` concatenates them.

---

## 3. `packages/providers/` — Reviewed changes

### 3.1 Context window (context-window.ts)

- `[low]` **`context-window.ts:49–54`** — `warnedRefs` mutable module-level state is documented as intentional (excluded from the prior review per `AGENTS.md`). No change needed.

- `[low]` **`context-window.ts:73–94`** — `resolveContextWindow` returns `ResolvedContextWindow` with `source: 'table'` for prefix matches. There's no way for callers to know whether the match was exact or prefix-derived. Consider adding `exact: boolean` to the result so the TUI can flag "approximate window" for prefix hits.

- `[low]` **`context-window.ts:84–92`** — Warning message falls back to `process.stderr.write` when `opts.warn` is absent. This writes to stderr even in library contexts where the caller might want to suppress warnings entirely. Add an explicit `warn: () => {}` pass-through in `registry.ts` or accept `warn?: false` to mean "silently fallback".

### 3.2 Key resolver (key.ts)

- `[low]` **`key.ts:16–24`** — The returned resolver accesses `process.env[varName]` directly. In tests this requires mutating `process.env` (see `registry.test.ts:36–44`, `57–70`). No option to inject a custom environment, making parallel test execution fragile if two suites set the same var. Consider an optional `env` parameter.

- `[low]` **`key.ts:26–29`** — Plain-string key warning is emitted at resolver-build time, not at config-load time. If the same provider is fetched multiple times (cache hit in `registry.ts`), the warning fires only once because `buildKeyResolver` is called only inside `buildProvider`, which is cached. This is fine, but if caching were removed the warning would duplicate.

### 3.3 Registry (registry.ts)

- `[low]` **`registry.ts:64–72`** — `resolve` uses `modelRef.indexOf('/')` to split provider from model. As the test at `registry.test.ts:15` confirms, this is intentional for nested provider paths (`openrouter/anthropic/claude-opus-4` → provider=`openrouter`, model=`anthropic/claude-opus-4`). The logic is correct but deserves a comment in the source, not just in the test.

- `[med]` **`registry.ts:20–39`** — `getModel` calls `keyResolver()` on every invocation. If `keyResolver` is an `env:` reference, this reads `process.env` every time a model is fetched. The provider factory (`createAnthropic` / `createOpenAI`) is also recreated every time. This is redundant — the factory and resolved key could be cached at provider-build time, with the env lookup happening lazily only on first `getModel()` call. Currently, a subagent spawn that calls `getModel` dozens of times will recreate the SDK provider object each time.

### 3.4 Test coverage

- `[low]` **`test/registry.test.ts`** — No test for `validateShape` rejecting unsupported shapes (e.g. `shape: 'google'`). The `loadProviders` happy-path test covers `openai` and `anthropic` but the error branch is untested.

---

## 4. Cross-cutting duplication

### 4.1 Markdown frontmatter walker duplication — quantified

All four packages (`commands`, `skills`, `modes`, `subagents`) implement the same tier-discovery pattern. Here is a line-by-line breakdown of what is copied versus unique:

| Component | Commands | Skills | Modes | Subagents |
|-----------|----------|--------|-------|-----------|
| `buildTiers` | Yes (45 lines) | Yes (39 lines) | Yes (45 lines) | Yes (39 lines) |
| `ancestorsBetween` | Yes (19 lines) | Yes (19 lines) | Yes (21 lines) | Yes (19 lines) |
| `isGitRoot` | Yes (7 lines) | Yes (7 lines) | Yes (7 lines) | Yes (7 lines) |
| `tier loop + collision tracking` | Yes (35 lines) | Yes (70 lines) | Yes (82 lines) | Yes (62 lines) |
| Frontmatter parser | Yes (54 lines, scalar only) | Yes (117 lines, +block scalars) | Yes (106 lines, +typed fields) | Yes (130 lines, forked from skills) |

**Total duplicated / near-duplicated lines: ~390 lines** across the four packages.

Specific clones:

1. **`commands/src/discover.ts:12–45`** and **`modes/src/discover.ts:19–45`** — `buildTiers` is byte-for-byte identical except for the `builtin` tier in modes (lines 41–42). The `ancestorsBetween` and `isGitRoot` in commands are also identical to skills/modes/subagents with one ordering difference noted above.

2. **`skills/src/discover.ts:78–151`** and **`subagents/src/agents/discover.ts:70–139`** — The discovery loop structure is identical: `readdirSync` → `statSync` on entry → filter by type → read file → parse frontmatter → validate name/description → check collision → set in map. The subagent version is ~12 lines shorter because it lacks the directory-per-skill requirement, but the control flow is the same.

3. **`skills/src/frontmatter.ts`** and **`subagents/src/agents/frontmatter.ts`** — The subagents file includes a comment: "Forked from @chimera/skills to keep @chimera/subagents free of a workspace dependency on the skills package." The two files are **105 lines vs 117 lines**, differing only by the addition of `parseToolsCsv` in subagents. This is an explicit fork, which is honest but means bug fixes in one must be manually ported to the other.

4. **`modes/src/frontmatter.ts`** is a typed variant that shares the same `---` fence detection and `unquote` logic but adds `tools` array and `cycle` boolean parsing.

**Recommendation**: Extract a shared `@chimera/discovery` (or `@chimera/core/discovery`) package containing:
- `buildTiers(assetType: string, opts)` — returns `Tier[]`
- `ancestorsBetween(start, stopAt)` — shared helper
- `isGitRoot(dir)` — shared helper
- `parseFrontmatter(source, schema?)` — a minimal frontmatter parser with block-scalar support and optional schema-driven type coercion (tools array, boolean, etc.)

This would remove ~250 lines of duplicated tier logic and ~100 lines of duplicated frontmatter parsing. The commands package already has a `ReloadingCommandRegistry` with `fs.watch`; the same watcher pattern could be shared.

---

## 5. Recommendations (prioritized)

1. **`[high]` Extract shared discovery helpers.** The tier-building and ancestor-walking code is copy-pasted across four packages. A single `@chimera/discovery` (or `core` sub-module) would remove ~250 lines of duplication and eliminate the subtle `ancestorsBetween` boundary inconsistency between commands and the other packages.

2. **`[med]` Normalize frontmatter parsers.** `modes` lacks block-scalar support that `skills` and `subagents` have. Either add block scalars to `modes` or extract a single parser with feature flags.

3. **`[med]` Cache provider SDK factories in `registry.ts`.** `createAnthropic` / `createOpenAI` are recreated on every `getModel()` call. Cache the factory alongside the provider object.

4. **`[med]` Add env-injection point to `buildKeyResolver` and `DefaultHookRunner`.** Both modules access `process.env` directly, making parallel test execution fragile.

5. **`[low]` Document the `name === stem` restriction in `modes` user docs.** The strict validation differs from subagents and will surprise users copying files between asset directories.
