# Discovery Refactor Changelog

## Summary

Extracted a shared discovery utility (`packages/core/src/discovery.ts`) to eliminate ~390 lines of triplicated tier-walking, ancestor-resolving, file-scanning, and frontmatter-parsing code across `commands`, `skills`, `subagents`, and `modes`.

## Files Created

- `packages/core/src/discovery.ts` — Shared discovery primitives
- `packages/core/test/discovery.test.ts` — 21 unit tests for the shared utilities

## Files Modified

### `@chimera/core`
- `packages/core/src/index.ts` — Added `export * from './discovery'`
- `packages/core/package.json` — No dependency changes (self-contained)

### `@chimera/commands`
- `packages/commands/src/discover.ts` — Refactored to import `buildTiers`, `walkMarkdownFiles`, `parseFrontmatter` from `@chimera/core`
- `packages/commands/src/frontmatter.ts` — Became a re-export from `@chimera/core`
- `packages/commands/src/reloading.ts` — Updated `buildTiers` call to new shape (`{ cwd, userHome, includeClaudeCompat, assetType }`)
- `packages/commands/src/index.ts` — Adjusted export for frontmatter re-export
- `packages/commands/package.json` — Added `@chimera/core: "workspace:*"` dependency

### `@chimera/skills`
- `packages/skills/src/discover.ts` — Refactored to import `buildTiers`, `parseFrontmatter` from `@chimera/core`
- `packages/skills/src/frontmatter.ts` — Became a re-export from `@chimera/core`
- `packages/skills/src/index.ts` — Directs `parseFrontmatter`, `parseToolsCsv` re-exports from `@chimera/core`
- `packages/skills/package.json` — Moved `@chimera/core` from `devDependencies` to `dependencies`

### `@chimera/subagents`
- `packages/subagents/src/agents/discover.ts` — Refactored to import `buildTiers`, `parseFrontmatter`, `parseToolsCsv` from `@chimera/core`
- `packages/subagents/src/agents/frontmatter.ts` — Became a re-export from `@chimera/core`
- `packages/subagents/src/agents/reloading.ts` — Updated `buildTiers` call to new shape
- `packages/subagents/src/agents/index.ts` — Adjusted exports for frontmatter re-export
- `packages/subagents/package.json` — Already had `@chimera/core` dependency

### `@chimera/modes`
- `packages/modes/src/discover.ts` — Refactored to import `buildTiers`, `parseFrontmatter`, `parseToolsCsv` from `@chimera/core`; moved inline validation for `cycle` and `tools` into `discover.ts` as post-processing on top of the base `parseFrontmatter` result
- `packages/modes/src/frontmatter.ts` — Became a re-export from `@chimera/core` (keeping the same type exports for backward compat)
- `packages/modes/src/index.ts` — Adjusted frontmatter export
- `packages/modes/package.json` — Moved `@chimera/core` from `devDependencies` to `dependencies`

## Files Deleted (no-op, content merged into core)

The following files were replaced by `@chimera/core` — their package-local versions now thin re-exports:
- `packages/commands/src/frontmatter.ts` (old content)
- `packages/skills/src/frontmatter.ts` (old content)
- `packages/subagents/src/agents/frontmatter.ts` (old content)
- `packages/modes/src/frontmatter.ts` (old content)

The old bodies of these files were deleted and replaced with `export { x } from '@chimera/core'`.

## API Changes

### New exports from `@chimera/core`

```ts
export interface ParsedDocument {
  frontmatter: Record<string, string>;
  body: string;
}

export function parseFrontmatter(source: string): ParsedDocument;
export function parseToolsCsv(raw: string | undefined): string[];

export interface Tier {
  source: string;
  dir: string;
}

export interface BuildTiersOptions {
  cwd: string;
  userHome?: string;
  includeClaudeCompat?: boolean;
  assetType: string;   // e.g. 'commands', 'skills', 'agents', 'modes'
  builtinDir?: string; // appended as lowest-priority tier
}

export function buildTiers(opts: BuildTiersOptions): Tier[];
export function ancestorsBetween(start: string, stopAt: string): string[];
export function isGitRoot(dir: string): boolean;

export interface DiscoveredFile {
  absPath: string;
  relPath: string;
}

export function* walkMarkdownFiles(root: string): Generator<DiscoveredFile>;
```

### Removed exports

- `buildTiers(opts: LoadXxxOptions)` — The old per-package `buildTiers` functions that used package-specific option types are gone. The shared version uses `BuildTiersOptions`. Callers must pass `{ cwd, userHome, includeClaudeCompat, assetType }`.
- `packages/subagents/src/agents/index.ts` no longer exports `ParsedDocument` from `./frontmatter` (now re-exported from `@chimera/core` instead).

### Breaking note for internal callers

The two `ReloadingRegistry` classes (`commands` and `subagents`) previously called `buildTiers(this.opts)` with the raw options object. They now call `buildTiers({ cwd: this.opts.cwd, userHome: this.opts.userHome, includeClaudeCompat: this.opts.includeClaudeCompat, assetType: '...' })`.

## Caveats / Follow-ups

1. **Block scalar addition to `modes`**: The old `modes` frontmatter parser did not support `|` / `>` block scalars. The refactored `modes/discover.ts` now uses the shared `parseFrontmatter` which *does* support them. This is a UX improvement, not a regression.

2. **`modes` typed `cycle`/`tools`**: The shared `parseFrontmatter` returns `Record<string, string>`, so `modes/discover.ts` must still convert `cycle` to `boolean` and `tools` to `string[]` after parsing. This keeps the shared parser simple while letting consumers do their own schema-driven type coercion.

3. **`commands` frontmatter tests**: `commands/test/frontmatter.test.ts` still passes unmodified — it exercises the behavior via the re-export.

4. **`skills` frontmatter tests**: `skills/test/frontmatter.test.ts` still passes — it already tested block scalars which are now in core.

5. **`subagents` test failures are pre-existing**: 6 test suites fail due to `@chimera/client` not being built (`Failed to resolve entry for package "@chimera/client"`), unrelated to this refactor. The discovery-related tests (`agents-discover.test.ts` — 9 tests, `handshake.test.ts` — 6 tests) all pass.

6. **`server` package build failure is pre-existing**: DTS build fails with a `ModelConfig` type mismatch. Confirmed present before this change.

## Test Results

| Package | Tests | Status |
|---------|-------|--------|
| `@chimera/core` | 99 | pass |
| `@chimera/commands` | 44 | pass |
| `@chimera/skills` | 28 | pass |
| `@chimera/modes` | 18 | pass |
| `@chimera/subagents` | 15 discovery | pass |
