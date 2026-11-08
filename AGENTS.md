# AGENTS.md

If the tdd skill is available, use it for all code changes.

Operational notes for agents working on this codebase. User-facing docs are in
`README.md` and `docs/`. This file targets things that aren't obvious from
reading the code.

[readme](./README.md)

## Package model

Workspace packages are consumed via their **built `dist/`**, not their `src/`.
Editing `packages/A/src/*.ts` does **not** update what `packages/B` sees
through `import '@chimera/A'` — you must rebuild A first.

```
pnpm --filter @chimera/<pkg> build      # build one package
pnpm -r build                           # build all
```

If you change `@chimera/commands` and then run `@chimera/tui` tests without
rebuilding, vitest errors with `Failed to resolve entry for package
"@chimera/commands"`. This is expected; just build.

Dependency DAG (no back-edges): `cli → tui, server, client, permissions,
hooks, sandbox, tools, providers, commands, skills, core`.

### `ai` is bundled into the CLI

`ai` is a **devDependency** of `packages/cli`, so tsup inlines what the CLI
imports from it. `tool` and `jsonSchema` survive that. `generateText` does
not: it pulls in the gateway provider and `@vercel/oidc`, a CommonJS module,
and the built binary dies at start with `Dynamic require of "path" is not
supported`. Vitest runs the sources, so only the tests that start
`dist/bin.js` notice.

For a model call in the CLI, use `askModel` from `@chimera/core`, where `ai`
is a real dependency. After a build, `node packages/cli/dist/bin.js --version`
shows in a second whether the binary still starts.

## User-home layout: always `~/.chimera/`, never `~/.config/chimera/`

Every piece of Chimera state under the user's home goes in `~/.chimera/`:
config (`config.json`), sessions, instances, logs, overlays, themes, hooks.
Do not introduce `~/.config/chimera/` paths — XDG-style placement was
explicitly rejected for this project when colour themes were added.
Project-local state mirrors the same name: `<cwd>/.chimera/`.

When adding a new global-state directory, default to
`join(homedir(), '.chimera', '<thing>')` and accept an override option for
tests. Grep for existing siblings before adding (`packages/cli/src/config.ts`,
`packages/core/src/persistence.ts`, etc.).

## Scripts

```
pnpm -r test                      # run every package's vitest suite
pnpm --filter @chimera/<pkg> test [name-pattern]
pnpm -r build                     # tsup build everywhere
pnpm fmt / pnpm lint              # biome (see "biome via rtk hook" below)
pnpm sandbox:build                # docker build chimera-sandbox:dev
```

### biome via the rtk hook

If you're running inside a Claude Code session with the `rtk-rewrite.sh`
PreToolUse hook installed, plain `pnpm lint` and any command containing
`biome` get rewritten to `rtk lint` (rtk's own analytics command) and the
biome worker dies with `Linter process terminated abnormally (possibly out
of memory)` — this is rtk's rewrite rule mis-routing the call, not an
actual OOM.

Use `pnpm biome:lint` (or `pnpm biome:lint:fix`) instead. The colon in the
script name evades rtk's pattern match, and the script body
(`node ./node_modules/@biomejs/biome/bin/biome ...`) invokes biome through
a path the hook doesn't intercept. The plain `pnpm lint` script is kept for
users running outside Claude Code where the hook isn't in play.

Docker-backed E2E tests are gated on `CHIMERA_TEST_DOCKER=1` and silently
skip otherwise. They live in `packages/cli/test/e2e-sandbox.test.ts` and
`packages/sandbox/test/`. Set the env var (and optionally
`CHIMERA_TEST_SANDBOX_IMAGE` to override the default `chimera-sandbox:dev`)
to run them.

Subagent E2E tests are gated on `CHIMERA_TEST_E2E=1` and live in
`packages/subagents/test/e2e-spawn.test.ts`. They spawn real `chimera serve`
processes; no provider credentials needed.

### Evals (`packages/evals`)

`pnpm --filter @chimera/evals evals run` runs real `chimera run` sessions
against a local LM Studio server and loads models onto the GPU. Do not start
it unless the user asks. See `docs/evals.md`.

- `pnpm --filter @chimera/evals test` is the unit suite and needs no model:
  it drives the harness with `test/fixtures/fake-chimera.mjs`. To try the CLI
  the same way, pass `--chimera <wrapper around the fake> --no-load` and set
  `CHIMERA_EVALS_RESULTS_DIR` so the fake runs stay out of `.results/`.
- The evals run `packages/cli/dist/bin.js`. Rebuild the CLI before a run that
  measures a change to a prompt, a tool or a profile.
- evalite 0.19 ignores `--hideTable` on `evalite run`; `hideTable` in
  `evalite.config.ts` is what hides its table.
- evalite needs `better-sqlite3`, a native module. It is in
  `onlyBuiltDependencies` in `pnpm-workspace.yaml`. A missing binding after
  an install means the build script did not run: `pnpm install --force`.
- The planned small-model work, with the findings of the first pass, is in
  `docs/scratch/small-model-tuning.md`.

## `pnpm typecheck` has known noise

`tsc -b` is run from the root for typechecking, but it can leak compiled
artifacts (`*.js`, `*.d.ts`, `*.cjs`) **into `src/` directories**. Clean up
after yourself:

   ```
   find packages -path '*/node_modules' -prune -o \
     \( -name '*.js' -o -name '*.js.map' \
        -o -name '*.d.ts' -o -name '*.d.ts.map' \
        -o -name '*.d.cts' -o -name '*.d.cts.map' \
        -o -name '*.cjs' -o -name '*.cjs.map' \) -print | \
     grep '/src/' | xargs rm -f
   rm -f tsconfig.tsbuildinfo
   ```

## TUI renderer

The TUI runs on Chimera's own line renderer; there is no React or Ink.

- `src/app/controller.ts` holds all TUI state in plain fields and handles
  every input event. `src/app/fullscreen.ts` lays the transcript viewport
  over the chrome on the alternate screen; `src/app/inline.ts` writes the
  transcript and the chrome into the terminal's scrollback. `src/mount.ts`
  wires either to the terminal.
- Line components (`src/ledger/*`, `src/cards/*`) render state to string
  lines for a width. Measure, clip and pad with `src/terminal/width.ts`
  only, never `.length`. A component keeps no state of its own except a
  card, whose state is plain fields read on every key.
- `src/terminal/keys.ts` parses each read into one event per key, in order;
  `src/terminal/host.ts` owns raw mode and the key, paste and mouse modes,
  and restores them on exit, suspend and hand-off.
- The screen writers (`src/terminal/inline-screen.ts`,
  `src/terminal/alt-screen.ts`) rewrite only changed rows, inside
  synchronized output.

## TUI testing conventions

- Test through `mountTui` with `test/harness.ts`: a fake client, scripted
  bytes on a `VirtualInput`, and a `VirtualTerminal` as stdout.
  `term.screen()` is what the user sees; `term.history()` adds the
  scrollback; `term.takeOutput()` is what was written since the last look.
- Send a burst of keys as one read: `keys('/goal x\r')`. No per-character
  sleeps are needed; keys act in order. A lone Esc waits for the escape
  timeout, so give it ~60 ms: `keys('\x1b', 120)`.
- Raw sequences: `\x03` Ctrl+C, `\x1b[A`–`D` arrows, `\x1b[5~`/`\x1b[6~`
  PgUp/PgDn, `\x1b[13;2u` Shift+Enter, `\x1b[Z` Shift+Tab, `\x1b[<64;x;yM`
  wheel up (SGR mouse), `\x1b[200~…\x1b[201~` a paste. Tab `\t`, Enter `\r`.
- Line components have `render(width)` tests of their own
  (`test/ledger-*.test.ts`, `test/cards.test.ts`); check display width with
  `displayWidth`, not `.length`.
- Do not assert a spinner frame: it moves every 80 ms.

## Agent construction in tests

`AgentOptions.contextWindow` is required (no default). Tests that build an
`Agent` directly must pass it — `200_000` is the conventional value for
fixtures. To exercise the unknown-model branch, also pass
`contextWindowIsApproximate: true`; that surfaces on `usage_updated` events
so the TUI can flag the window value as approximate.

`packages/providers`'s `resolveContextWindow` deduplicates unknown-model
warnings in module-level state. Tests asserting on warning counts must call
`__resetContextWindowWarnings()` (imported from `../src/context-window`,
not the package barrel) at the start of each case.

## Planning: wayfinder and Burnlite

Maps, specs and tickets live in Burnlite, Project `CHIM`. Read
`docs/agents/issue-tracker.md` before any planning-skill or tracker
operation (`/wayfinder`, to-spec, to-tickets, implement, triage): it maps
each operation to a Burnlite tool. Settled project terms are in
`GLOSSARY.md`; use them in code, docs and tickets.

## Commands system (hot-reload)

Commands (`.chimera/commands/*.md`, `.claude/commands/*.md`) are:

- **Client-side expanded.** The server never sees the expanded body during a
  run. `expand()` is pure string substitution.
- **TUI-only hot-reloaded.** The `ReloadingCommandRegistry` watches tier dirs
  with `fs.watch` (150ms debounce). `listCommands()` on the server returns a
  per-session snapshot captured at session creation — mid-session reloads
  don't affect it (see `docs/COMMANDS.md`, "Hot reload in the TUI").

If adding similar assets (skills, subagents), follow the same pattern:
reloading registry for the TUI, frozen snapshot on the server, docs-side
`/reload` fallback for tier dirs that appear post-startup.

## Coding style

Biome-enforced: 2-space indent, single quotes, semicolons, trailing commas,
lineWidth 100. `organizeImports: true`. `noExplicitAny: warn`,
`useImportType: off`, `noNonNullAssertion: off`.

Inherited from user rules:

- **No comments that restate code.** Only explain non-obvious _why_.
- **No emojis** unless explicitly requested.
- **No backwards-compat shims** for deleted code — just delete it.
- **Don't add error handling / validation for impossible cases.**
- **Descriptive variable names.** Avoid one- and two-letter throwaways
  (`r`, `cr`, `ra`, `rb`, `fr`, `e` for entries, `sb` for scrollback)
  for values that survive more than one statement. Prefer
  `createResponse`, `forkResponse`, `errorBody`, `entry`, `scrollback`,
  etc. Exceptions: short-scope loop indices (`i`, `j`), arrow-callback
  parameters (`.filter((s) => ...)`, `.map((c) => ...)`), single-use
  Promise-executor parameters (`new Promise((r) => setTimeout(r, 1))`,
  `(resolve) => ...`), caught-error bindings (`err` / `error`),
  well-known math vars (`x`, `y`, `dx`), and immediately-destructured
  tuple / discard-alias elements (`const { id: _id, ...rest } = …`)
  remain idiomatic. All existing source and test files in this repo
  have been swept to match this rule as of this commit.

## Commit conventions

Format: `<type>(<scope>): <short description>`. Types seen: `feat`, `fix`,
`docs`, `chore`. Scope is a package name or area (`tui`, `cli`, `commands`,
`agents`, etc.). Body wrapped to ~72 cols.

**Do not add `Co-Authored-By` trailers.** Claude did much of the early work
on this repo, so historical commits carry that trailer; other agents
pattern-match on it and start attributing their own commits to Claude.
Leave trailers off entirely unless the user explicitly asks for one.

Split large changes into logically coherent commits rather than one mega-
commit. Don't push or open PRs unless explicitly asked.

## Session rewind

`truncateEventsAtIndex` uses byte offsets precomputed by `readCheckpoints`
against the on-disk `events.jsonl` byte layout. These offsets are only valid
while no new events are being appended — the server enforces this via a rewind
lock that blocks new runs and compactions while truncation is in flight. Any
future concurrent-write path through `events.jsonl` must respect this invariant.

Workspace restore (`WorkspaceCheckpoints` in core) snapshots the cwd into a
shadow git repo before each user message (`AgentRegistry.run`/`injectMessage`,
gated by the `workspaceCheckpoints` registry option — off in tests, enabled by
the CLI commands from config). Snapshot records are keyed by
`(userMessage, occurrence)`, not checkpoint index, because checkpoint indices
are message positions in the latest snapshot and shift under compaction. The
rewind handler restores **before** truncating, while the byte offsets are
still valid.
