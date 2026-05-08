# Chimera Code-Quality Review — 2026-05-08

**Scope:** All 14 packages in the monorepo  
**Baseline:** HEAD (post-April-26, commits through `ab8b8f4`)  
**Prior reviews:** `chimera-findings.md` (2026-04-26), `chimera-findings-claude.md` (2026-04-26)

---

## 1. Overall Summary

| Metric | Count |
|--------|-------|
| [crit] | 0 |
| [high] | 18 |
| [med] | 42 |
| [low] | 32 |

The codebase remains solid (B+ overall), with strong architecture, good test coverage (especially in `core`, `tools`, and `skills`), and clear separation of concerns. However, **all [high] findings from the April review remain unaddressed**, and new features (modes, hooks, subagent loading, multiline input, glob/grep tools) introduced several new issues, particularly around duplication (discovery walkers, loader boilerplate, reloading registries), boundary validation (still no Zod schemas on HTTP endpoints), and type-safety gaps.

---

## 2. [high] Findings (18 total)

### 2.1 Unresolved from April review

| # | Finding | Location | Recommendation |
|---|---------|----------|----------------|
| 1 | No Zod validation on HTTP JSON bodies | `server/src/app.ts:51,131,189,209,222,258,292` | Add Zod schema per endpoint; reject 400 on parse failure |
| 2 | SSE frame parsing without validation | `client/src/sse.ts:47–70` | Validate envelope shape; log/surface parse errors |
| 3 | Permission error masking (409 for all errors) | `server/src/app.ts:295–301` | Narrow catch to exact "already-resolved" condition |
| 4 | `runInternal` ~430 lines / ~340-line switch loop | `core/src/agent.ts:507–938` | Extract `StreamProcessor`; test shadow logic in isolation |
| 5 | `App.tsx` ~1754 lines, `handleSlash` ~500 lines inline | `tui/src/App.tsx:721–1221` | Extract slash-command dispatcher module |
| 6 | `remember as any` on permission resolve | `tui/src/App.tsx:1265`, `PermissionModal.tsx:59,68` | Remove casts; union types are already correct |
| 7 | Drive-loop duplication (child vs in-process) | `subagents/src/spawn-child.ts:213–283`, `spawn-in-process.ts:57–127` | Extract shared `SubagentDriver` interface |

### 2.2 New since April review

| # | Finding | Location | Recommendation |
|---|---------|----------|----------------|
| 8 | Mode-switch logic duplicated (idle vs run-start) | `core/src/agent.ts:515–559` vs `390–412` | Share `applyModeSwitch(name, emit)` helper |
| 9 | `EventQueue` push/close race + no tests | `core/src/event-queue.ts` | Snapshot resolver list in `close`; add stress tests |
| 10 | `writeSessionMetadata` failure → stale mode silently | `core/src/persistence.ts:71–80` + `agent.ts:405` | Log warning on metadata write failure |
| 11 | Four CLI loaders are ~90% identical | `cli/src/*-loader.ts` (×4) | Extract generic `makeConfigLoader` factory |
| 12 | Discovery walkers are triplicated (×3) + frontmatter parser (×3) | `commands/src/discover.ts`, `skills/src/discover.ts`, `subagents/src/agents/discover.ts` | Extract shared `@chimera/discovery` package |
| 13 | `ARGS_SCHEMA` declared but not defended at execute boundary | `subagents/src/spawn-tool.ts:19–61, 84` | Run `ARGS_SCHEMA.parse(args)` at execute entry |
| 14 | Child-process spawn-tool branch has zero unit tests | `subagents/src/spawn-tool.ts:233–300` | Mock `ChildHandle` to exercise child branch |
| 15 | `event-queue.ts` no tests; push/close race on resolver list | `core/src/event-queue.ts` | Snapshot `resolvers` before iterating in `close` |
| 16 | SSE subscribe `useEffect` races on re-subscription | `tui/src/App.tsx:354–370` | Add `await generator.return()` in finally |
| 17 | `GatedExecutor` hardcodes `tool: 'bash'` for all exec calls | `permissions/src/gated-executor.ts:57–64` | Pass actual tool name into gate |
| 18 | `spawn-child.ts` stderr buffer O(n²) allocation | `subagents/src/spawn-child.ts:116–122` | Use bounded array/ring buffer |

---

## 3. [med] Highlights (42 total)

The full per-package reports contain all 42 [med] items. Key themes:

- **Duplication:** `ReloadingCommandRegistry` / `ReloadingAgentRegistry` (~95% identical), `commands/src/discover.ts` / `skills/src/discover.ts` / `subagents/src/agents/discover.ts`, `modes/src/discover.ts`, four CLI loader files.
- **Boundary validation:** `client/src/sse.ts` drops malformed frames silently; `server/src/app.ts` DELETE leaks raw error messages; `hook-bridge.ts` coerces non-objects to `{}`.
- **Type-safety:** Seven `as { input?: unknown }` casts on SDK stream parts (`agent.ts`); `as { toolCallId?: string }` in `spawn-tool.ts`; `as any` in `PermissionModal.tsx`.
- **Concurrency:** `agent-registry.ts` silently swallows active-run rejection; `hook-bridge.ts` `inFlight` Map leaks orphaned entries; SSE `writeSSE` after abort in server.
- **Test gaps:** No tests for `EventQueue` (stress); no `App.tsx` slash-command integration tests; no child-process branch tests in subagents; no `PermissionModal` full-flow test.
- **New packages:** `modes` frontmatter lacks block-scalar support; `hooks` runner swallows EPERM on kill; `providers` recreates SDK factory on every `getModel()` call.

---

## 4. Top 10 Actionable Fixes (Priority Order)

1. **Add Zod schemas** to every `await c.req.json()` in `server/src/app.ts` — single highest-impact change (blocks real bugs).
2. **Extract a shared discovery package** (`buildTiers`, `ancestorsBetween`, `isGitRoot`, `parseFrontmatter`) — eliminates ~400 lines of triplication.
3. **Collapse four CLI loaders** into a single generic factory — prevents drift.
4. **Extract `SubagentDriver`** to unify child/in-process drive loops — fixes interrupt inconsistency too.
5. **Extract slash-command dispatcher** from `App.tsx` — cuts the file by ~500 lines.
6. **Remove `as any` casts** on permission resolution (App.tsx + PermissionModal.tsx).
7. **Add Zod parse** to `spawn-tool.ts` execute entry.
8. **Fix stderr buffer** in `spawn-child.ts` (bounded array instead of `+=`).
9. **Add `await generator.return()`** to SSE subscribe `useEffect` to prevent subscription races.
10. **Add unit tests for child-process spawn-tool branch** — currently zero coverage.

---

## 5. Per-Package Report Files

| Package | Report |
|---------|--------|
| server, client, permissions | `reviews/backend-boundary-review.md` |
| core | `reviews/core-engine-review.md` |
| subagents | `reviews/subagents-review.md` |
| tools, sandbox | `reviews/tools-sandbox-review.md` |
| cli, commands, skills | `reviews/cli-commands-skills-review.md` |
| tui | `reviews/tui-review.md` |
| modes, hooks, providers | `reviews/new-packages-cross-cutting-review.md` |

---

*Generated by Legato swarm, 7 parallel workers, 2026-05-08*
