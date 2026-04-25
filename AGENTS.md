# AGENTS.md

Operational notes for agents working on this codebase. User-facing docs are in
`README.md` and `docs/`. This file targets things that aren't obvious from
reading the code.

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
sandbox, tools, providers, commands, skills, core`.

## Scripts

```
pnpm -r test                      # run every package's vitest suite
pnpm --filter @chimera/<pkg> test [name-pattern]
pnpm -r build                     # tsup build everywhere
pnpm fmt / pnpm lint              # biome
pnpm sandbox:build                # docker build chimera-sandbox:dev
```

Docker-backed E2E tests are gated on `CHIMERA_TEST_DOCKER=1` and silently
skip otherwise. They live in `packages/cli/test/e2e-sandbox.test.ts` and
`packages/sandbox/test/`. Set the env var (and optionally
`CHIMERA_TEST_SANDBOX_IMAGE` to override the default `chimera-sandbox:dev`)
to run them.

Subagent E2E tests are gated on `CHIMERA_TEST_E2E=1` and live in
`packages/subagents/test/e2e-spawn.test.ts`. They spawn real `chimera serve`
processes; no provider credentials needed.

## `pnpm typecheck` has known noise

`tsc -b` is run from the root for typechecking, but:

1. It emits pre-existing JSX errors in `packages/tui/src/*.tsx` because the
   root tsconfig doesn't set `jsx`. Harmless — `tsup` builds fine with its own
   per-package tsconfig.
2. It can leak compiled artifacts (`*.js`, `*.d.ts`, `*.cjs`) **into `src/`
   directories**. Clean up after yourself:

   ```
   find packages -path '*/node_modules' -prune -o \
     \( -name '*.js' -o -name '*.js.map' \
        -o -name '*.d.ts' -o -name '*.d.ts.map' \
        -o -name '*.d.cts' -o -name '*.d.cts.map' \
        -o -name '*.cjs' -o -name '*.cjs.map' \) -print | \
     grep '/src/' | xargs rm -f
   rm -f tsconfig.tsbuildinfo
   ```

## TUI testing conventions

Uses `ink-testing-library` + `vitest`. Two things catch people:

- **Per-char sleeps when feeding stdin.** React state updates for each
  keystroke race with follow-up keys (e.g. Enter after typing a command).
  Use the `type()` helper pattern already in
  `packages/tui/test/slash-dispatch.test.tsx`:

  ```ts
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 1));
  }
  await new Promise((r) => setTimeout(r, 20));
  ```

- **Raw escape sequences for special keys.** `\x03` = Ctrl+C, `\x1b` = Esc,
  `\x1b[A/B/C/D` = arrows, `\x1b[5~`/`\x1b[6~` = PageUp/PageDown,
  `\x1b[<64;x;yM` = wheel-up (SGR mouse). Tab = `\t`, Enter = `\r`.

## Ink (v7) specifics

- `render()` options we rely on: `exitOnCtrlC: false` (so our handler
  interrupts instead of exiting) and `stdin` (custom stream — see
  `packages/tui/src/mouse.ts`).
- A custom stdin stream must implement `isTTY`, `setRawMode`, `setEncoding`,
  `pause`, `resume`, **and `ref`/`unref`** — Ink calls ref/unref for event
  loop lifetime management. `PassThrough` doesn't provide those; delegate to
  the upstream source.

## OpenSpec workflow

Changes live in `openspec/changes/<name>/` with `proposal.md`, `design.md`,
`specs/**/*.md`, and `tasks.md`. Archived changes move to `openspec/specs/`.

Useful commands:

```
openspec list --json
openspec status --change <name> --json
openspec instructions apply --change <name> --json
```

`tasks.md` is the canonical task list — edit `[ ]` → `[x]` as you complete
each one, rather than tracking in-memory. Slash commands `/opsx:apply`,
`/opsx:propose`, `/opsx:archive` wrap the above.

## Commands system (hot-reload)

Commands (`.chimera/commands/*.md`, `.claude/commands/*.md`) are:

- **Client-side expanded.** The server never sees the expanded body during a
  run. `expand()` is pure string substitution.
- **TUI-only hot-reloaded.** The `ReloadingCommandRegistry` watches tier dirs
  with `fs.watch` (150ms debounce). `listCommands()` on the server returns a
  per-session snapshot captured at session creation — mid-session reloads
  don't affect it (documented in the spec).

If adding similar assets (skills, subagents), follow the same pattern:
reloading registry for the TUI, frozen snapshot on the server, docs-side
`/reload` fallback for tier dirs that appear post-startup.

## Coding style

Biome-enforced: 2-space indent, single quotes, semicolons, trailing commas,
lineWidth 100. `organizeImports: true`. `noExplicitAny: warn`,
`useImportType: off`, `noNonNullAssertion: off`.

Inherited from user rules:

- **No comments that restate code.** Only explain non-obvious *why*.
- **No emojis** unless explicitly requested.
- **No backwards-compat shims** for deleted code — just delete it.
- **Don't add error handling / validation for impossible cases.**

## Commit conventions

Format: `<type>(<scope>): <short description>`. Types seen: `feat`, `fix`,
`docs`, `chore`. Scope is a package name or area (`tui`, `cli`, `commands`,
`openspec`, etc.). Body wrapped to ~72 cols. Trailer:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Split large changes into logically coherent commits rather than one mega-
commit. Don't push or open PRs unless explicitly asked.
