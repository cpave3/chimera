# CLI, Commands & Skills Code-Quality Review

Scope: `packages/cli/`, `packages/commands/`, `packages/skills/`
Severity tags: `[crit]` / `[high]` / `[med]` / `[low]`. Every finding cites a verified `file:line`.

---

## 1. `packages/cli/src/factory.ts` `build()` — still long procedural setup

- `[med]` **`build()` spans L143–366 (~224 lines).** The prior review flagged this as a long procedural setup that wires providers, sandbox, gates, and persistence inline. Six months later it is 24 lines longer — the mode-switch logic at L330–360 now adds ~30 lines of additional inline setup. The comment block at L180–186 even admits the pattern (`// filled in below after gate is built`).

  Recommendation: extract named construction helpers:
  - `resolveModelAndWindow(init)` -> `{ languageModel, resolvedWindow }`
  - `buildExecutors(init, agent)` -> `{ hostExecutor, sandboxExecutor }`
  - `buildToolsWithSpawn(init, agent, gate, sandboxExecutor, hostExecutor)` -> `{ tools, formatters }`
  - `applyModeFiltering(tools, activeMode, agent)` -> `filteredTools`

  This would cut `build()` to ~80 lines and make each phase independently testable.

---

## 2. `packages/cli/src/program.ts` — option application and action duplication

### 2.1 `applySubagentOptions` / `applySandboxOptions` still mutate a passed-in `Command`

- `[med]` **`applySubagentOptions` (L22–28) and `applySandboxOptions` (L36–54)** return the same `Command` they were given — a Fluent-style no-op that is technically a side-effecting mutation. `applyModeOptions` (L30–34) follows the same pattern. They are nested 3-deep at L64–84, L171–205, etc.

  Recommendation: replace with a pure builder that returns option descriptors (e.g. `{ name: '--sandbox', parser: ... }`) and apply them via a loop — or use `Command#addOption()` imperatively without pretending to return a value.

### 2.2 Per-subcommand action bodies overlap with `commands/*.ts`

- `[med]` **The `run` action body (L85–117)** re-implements argument validation (`--command` vs positional, empty prompt check) that duplicates logic inside `runOneShot`. The `resume` action (L278–309) and `continue` action (L326–347) both call `runInteractive` with near-identical option bags — the only differences are session-id resolution. A shared `resolveSessionForResume(opts)` helper would collapse ~60 duplicate lines.

- `[low]` **`runServe` receives `sandboxFlags: opts` (L215)** and `runInteractive` receives `sandboxFlags: opts` (L305) — the raw commander options object is forwarded wholesale, meaning `runServe` and `runInteractive` depend on the *shape* of the commander options bag. If a new sandbox option is added, every action body must be updated.

  Recommendation: parse sandbox flags once at the program level (e.g. inside a `preAction` hook) and attach them to `cmd.opts()` as a typed `CliSandboxOptions` object.

---

## 3. NEW loaders — duplication across `agents-loader.ts`, `commands-loader.ts`, `modes-loader.ts`, `skills-loader.ts`

- `[high]` **The four loader files (`agents-loader.ts`, `commands-loader.ts`, `modes-loader.ts`, `skills-loader.ts`) are ~90% identical**, varying only in:
  - package import (`@chimera/subagents` vs `@chimera/commands` vs `@chimera/modes` vs `@chimera/skills`)
  - config key (`config.agents` vs `config.commands` vs `config.modes` vs `config.skills`)
  - disabled flag name (`agentsDisabled` vs `skillsDisabled` vs `modesDisabled` — commands lacks one)
  - reloadable constructor name (`ReloadingAgentRegistry` vs `ReloadingCommandRegistry`)

  Identical boilerplate duplicated:
  - `claudeCompatOverride` option interface field
  - `configDisabled || opts.xxxDisabled` guard
  - `claudeCompat = opts.claudeCompatOverride ?? opts.config.xxx?.claudeCompat ?? true`
  - Static `EMPTY_REGISTRY` object with `all/list`, `find`, `collisions` (and sometimes `paths` or `buildDescriptionIndex`)
  - `onWarning` callback passthrough

  Recommendation: extract a generic `makeConfigLoader<TRegistry, TOptions, TConfigKey>` factory or a code-generated barrel. The current copy-paste is four Deep Copies that will drift.

---

## 4. `packages/commands/src/expand.ts` — client-side command expansion

- `[low]` **`splitArgs` (L6–28)** does not handle escaped quotes inside quoted strings (`"say \"hello\""`). The comment at L4 says "Backslash-escapes are not recognized" — this is intentional per the spec, but it means commands containing quotes in args will mis-split. Document the limitation in the user-facing commands spec or add a test demonstrating the known broken case.

- `[low]` **`expandBody` L63** uses a regex `/\$([1-9])(?!\d)/g` for positional substitution. The negative lookahead works, but the comment at L61 (`careful not to match $10`) is worth a unit test — there is no test for `$10` avoidance today.

- `[low]` **Date formatting (L76–81)** is not locale-aware (`getMonth()` +1 offset is hard-coded). Tolerable for a CLI, but a comment explaining the ISO-like choice would help.

---

## 5. Discovery walkers — three parallel Markdown walkers

### 5.1 `packages/commands/src/discover.ts` and `packages/skills/src/discover.ts`

- `[high]` **`commands/src/discover.ts` and `skills/src/discover.ts` remain parallel frontmatter-aware Markdown walkers**, both implementing:
  - `buildTiers(opts)` with identical `ancestorsBetween` logic
  - `ancestorsBetween(start, stopAt)` with near-identical git-root stopping
  - `isGitRoot(dir)` — literally the same 7 lines in both files
  - Tier-priority collision detection (`byName` Map + `collisions` array)

  The only material differences:
  - Commands walks subdirectories recursively with a stack-based DFS (`walkMarkdownFiles`), while skills only looks one level deep (directory = skill name) and expects a `SKILL.md` inside.
  - Commands uses `toCommandName(relPath)` for namespace colon-separation; skills uses `basename(dirPath)`.

  The prior review (§7 Duplication) already flagged this. It has not been addressed.

### 5.2 Third walker in `packages/subagents/src/agents/discover.ts`

- `[high]` **`subagents/src/agents/discover.ts` is a third copy** of the same walker. It duplicates `buildTiers`, `ancestorsBetween`, `isGitRoot`, collision logic, and even the warning-formatting pattern. It also carries a *fourth* copy of `parseFrontmatter` (`subagents/src/agents/frontmatter.ts:15`), which the file itself admits: "Forked from @chimera/skills to keep @chimera/subagents free of a workspace dependency."

  Recommendation: create a shared `@chimera/discovery` (or internal utility in `@chimera/core`) package with:
  - `buildTiers({ cwd, userHome, includeClaudeCompat, dirs: ['commands'|'skills'|'agents'] })`
  - `walkMarkdownFiles(root)`
  - `ancestorsBetween(start, stopAt)`
  - A generic `discover<T>(opts, parseEntry): DiscoverResult<T>`

  This would eliminate ~400 lines of duplicated code across three packages.

---

## 6. `packages/commands/src/discover.ts` vs `skills/src/discover.ts` walker differences

- `[med]` **Commands walks symlinks via `statSync` (L161–169); skills does not.** If a skill directory is a symlink, `statSync(dirPath).isDirectory()` (skills L95) will return true for the symlink itself, but there is no `isSymbolicLink()` branch. This inconsistency means symlinked `.chimera/skills/` dirs may not be followed on some platforms, while `.chimera/commands/` symlinks are.

  Recommendation: standardise symlink handling in the shared walker.

- `[med]` **Skills emits warnings for invalid entries (name mismatch, missing description); commands silently skips unreadable files (L103–107 `catch { continue }`).** The user experience is inconsistent — skills tell you what's wrong; commands swallow errors.

  Recommendation: pass `onWarning` through commands discovery too, or silence both uniformly.

---

## 7. `packages/commands/src/frontmatter.ts` vs `skills/src/frontmatter.ts` vs `subagents/src/agents/frontmatter.ts`

- `[high]` **Three copies of `parseFrontmatter` exist**, two of which are identical (commands and skills), while the subagents version is a superset with block-scalar support. The commands/skills version lacks block-scalar parsing; if a user writes a multi-line description in a command frontmatter using `|` or `>`, it silently truncates or mis-parses.

  Recommendation: unify on the subagents implementation (which supports block scalars) and export it from a single location. The workspace-dependency problem can be solved by moving the parser to `@chimera/core` or a new `@chimera/markdown` package.

---

## 8. Reloading registry duplication

- `[med]` **`ReloadingCommandRegistry` (`commands/src/reloading.ts`) and `ReloadingAgentRegistry` (`subagents/src/agents/reloading.ts`) are ~95% identical** — same watcher installation, debounce, `onChange` subscription, `close()`, `reload()`, and event-filtering logic. The only differences are method names (`list()` vs `all()`, `expand()` vs `buildDescriptionIndex()`) and the inner registry type.

  Recommendation: extract a `ReloadingRegistry<T, R extends BaseRegistry>` base class or a factory. This is another ~250 lines of near-exact duplication.

---

## 9. List command duplication (`agents.ts`, `commands.ts`, `skills.ts`)

- `[med]` **`runAgentsList` (agents.ts), `runCommandsList` (commands.ts), and `runSkillsList` (skills.ts)** are ~40 lines each and differ only in:
  - which loader they call
  - which registry method they use (`all()` vs `list()`)
  - the header strings (`NAME`, `SOURCE`, `DESCRIPTION`)

  Recommendation: a single `runList<T>({ loader, format })` helper in `packages/cli/src/commands/shared.ts` would collapse these to ~10 lines each.

---

## 10. Test coverage gaps

- `[high]` **`packages/cli/test/factory.test.ts` (~168 lines) exercises only 5 of ~30 construction branches** in `CliAgentFactory.build()`. No tests for:
  - Sandbox path (DockerExecutor construction, `liveSandboxes`)
  - Skills/modes injection into system prompt
  - `toolsAllowlist` filtering
  - Mode resolver (`setModeResolver` callback)
  - `systemPromptOverride`
  - `getSandbox` / `dispose`
  - Model fallbacks when providerSpec is missing

- `[med]` **`packages/cli/test/program.test.ts` (104 lines) is a smoke suite** — it checks `--help` output and `ls` but does not exercise the option-parsing edge cases (e.g. `--sandbox-mode` without `--sandbox`, `--command` + positional prompt, `--resume` string vs boolean).

- `[med]` **No tests for `parseSandboxFlags` negative cases** (invalid mode, invalid network, flags without `--sandbox`). The `program.test.ts` has one integration test for the `--sandbox-mode` rejection, but the pure function has no unit tests.

- `[med]` **No tests for `agents-loader.ts`, `commands-loader.ts`, `modes-loader.ts`, `skills-loader.ts`.** These are thin wrappers, but the EMPTY_REGISTRY fallback and the `claudeCompatOverride` logic are completely uncovered.

- `[med]` **No tests for `commands/src/registry.ts` `expand` error path.** `InMemoryCommandRegistry.expand` throws on unknown command — this path is tested indirectly through `expand.test.ts` but the registry wrapper itself has no dedicated unit tests.

- `[low]` **`commands/test/reloading.test.ts` does not test watcher error handling** (the `watcher.on('error', ...)` and `catch` branches in `installWatchers`).

- `[low]` **`skills/test/activation.test.ts` only tests the lookup table**, not the integration with the Agent's event emission. The `buildSkillActivationLookup` function is pure and well-tested, but whether the factory actually wires it into `agent.setSkillActivation` is not verified.

---

## 11. Minor issues

- `[low]` **`packages/cli/src/factory.ts:207–210`** — silent `catch` on `writeSessionMetadata`. Still no logging of the failure. At minimum call `this.warn(...)`.

- `[low]` **`packages/cli/src/program.ts:458`** — `program.exitOverride()` means commander throws on `--help`. The `runCli` catch block (L478–484) handles this, but the pattern is fragile — any caller of `buildProgram()` who forgets the `exitOverride` handling will get an unhandled rejection.

- `[low]` **`packages/cli/src/commands/serve.ts:175–186`** — `process.exit(0)` inside the SIGINT/SIGTERM handler races `server.close()`. Use `process.exitCode = 0` after awaiting cleanup.

- `[low]` **`packages/commands/src/types.ts:21`** — `onWarning?: (message: string) => void` is optional, but `discover.ts` uses `opts.onWarning ?? (() => {})` (skills L82) while commands `load.ts` branches with `if (opts.onWarning)` (L12). Inconsistent null-handling.

---

## Summary of top recommendations

1. **Extract a shared discovery package** (`@chimera/core` or new) to unify `buildTiers`, `ancestorsBetween`, `isGitRoot`, `walkMarkdownFiles`, and `parseFrontmatter`. This eliminates ~400 lines of triplicated code.
2. **Collapse the four CLI loaders** into a single generic factory or code-generated barrel. The copy-paste is a maintenance hazard.
3. **Extract a `ReloadingRegistry` base class** for commands and agents (and skills/modes if they ever need hot-reload).
4. **Decompose `CliAgentFactory.build()`** into named construction-phase helpers. At ~224 lines it is the second-largest method in the CLI after `program.ts` itself.
5. **Add unit tests for `CliAgentFactory` sandbox, allowlist, mode-resolver, and override branches.** Coverage is heavily skewed toward the happy path.
