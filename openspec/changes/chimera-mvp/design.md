## Context

`spec.md` is the authoritative V1 design for Chimera, a terminal-native AI coding agent. It describes twelve packages, a Docker sandbox with three filesystem modes, skills and commands, subagents that are themselves Chimera instances, and a full HTTP + SSE surface. That scope is too large to ship as one change.

This design scopes the MVP down to the "walking skeleton": the subset of V1 that proves the SDK-first, TUI-second, permission-aware core and that every later capability (sandbox, subagents, skills, commands) can slot in as an additive change without reshaping the core. Goal and wishlist documents inform principles (small surface area, plugin-style composition via the `Executor` / event-stream seams) but do not introduce scope beyond what `spec.md` specifies.

Stakeholders: solo developer / primary implementer (Claude Code). Deployment target: local developer workstation (Linux / macOS). No production users yet.

## Goals / Non-Goals

**Goals:**

- Produce a usable `chimera` binary that, given an API key, runs interactive coding sessions against an OpenAI- or Anthropic-shaped endpoint.
- Keep every consumer (TUI, future subagents, future Slack harness) behind the **same** `ChimeraClient` / `AgentEvent` surface — no side-channel hooks.
- Make the `Executor` interface the single seam for future sandboxing and permission enforcement so the sandbox change is additive.
- Get from zero to `chimera run "prompt"` working end-to-end before building the TUI on top (matches `spec.md` §19 build order).
- Preserve `spec.md`'s stated event names, tool signatures, and HTTP paths verbatim — deviating creates churn for future changes.

**Non-Goals:**

- No Docker sandbox (`@chimera/sandbox`). `SandboxMode` is represented in types as a value set `{ "off" }` with reserved room for future variants, but no Docker executor exists.
- No subagents (`@chimera/subagents`). `spawn_agent` is not registered; `--machine-handshake` on `chimera serve` is specified and implemented (cheap, used by future subagent change) but has no in-tree caller.
- No skills or commands packages. The system prompt composition deliberately leaves a hook for appending an index; MVP injects nothing.
- No MCP, plan mode, web UI, bearer-token auth, user-scope permission rules, regex rule patterns, keychain storage, retrievable pruned tool outputs (wishlist idea).
- No compaction. Sessions that exceed the context window error and end. Compaction lands in a follow-on change.

## Decisions

### D1. Monorepo layout matches `spec.md` §3, but with eight of twelve packages present

**Decision:** Create `packages/{core,providers,tools,permissions,server,client,tui,cli}`. Do not create `packages/{sandbox,permissions-gating-beyond-local,skills,commands,subagents}` yet.

**Why:** The eight packages are exactly the DAG rooted at `cli → tui, server, client, permissions, tools, providers, core`. Leaving the other four out of the workspace keeps `pnpm-workspace.yaml` honest and makes it obvious in later changes that sandbox/skills/commands/subagents are real additions, not edits.

**Alternatives considered:**

- Creating empty placeholder packages for the deferred four. Rejected — dead packages invite confused imports and break `tsc -b` with empty project references.
- Collapsing into a single package for MVP simplicity. Rejected — the dependency DAG is load-bearing: it is what prevents circular imports when skills and sandbox land later, and reshuffling later would void every consumer's import paths.

### D2. AI SDK `streamText` with `stopWhen: stepCountIs(maxSteps)` is the agent loop

**Decision:** Use `streamText` directly; do not wrap in a custom orchestrator. Consume `fullStream` and map part types to `AgentEvent`s exactly as `spec.md` §4.4 prescribes. Interrupt is an `AbortController` wired into `streamText` plus `child_process.spawn({ signal })` on bash.

**Why:** The AI SDK already handles tool dispatch, multi-step loops, and provider normalization. Writing a custom loop forfeits that and re-introduces the provider-quirk burden that `@ai-sdk/openai` and `@ai-sdk/anthropic` already absorb.

**Alternatives considered:**

- Hand-rolled loop with manual streaming. Rejected — duplicates SDK work without adding capability and couples us more tightly to specific providers' wire shapes.

### D3. Shape-based provider config, not vendor-enumerated

**Decision:** `providers[id]` takes `{ shape: "openai" | "anthropic", baseUrl, apiKey }`. `modelId` string is `providerId/modelId`. No hard-coded list of "supported providers".

**Why:** `spec.md` §5 calls this out as the explicit design. It makes OpenRouter, vLLM, Bedrock/Vertex proxies, and Anthropic/OpenAI all one code path. Vendor-enumerating would require a registry change every time someone adds a proxy.

**Trade-off:** Users can configure combinations that silently drop features (e.g. Anthropic `extended_thinking` against an OpenAI-shaped endpoint). We document known-good combos in `PROVIDERS.md` rather than detect at runtime.

### D4. `Executor` is the only abstraction tools know about

**Decision:** Tools never touch `child_process` or `fs` directly. MVP only provides `LocalExecutor`, but `bash` accepts a `target: 'sandbox' | 'host'` arg in its Zod schema even though both resolve to `LocalExecutor` today. `edit`, `read`, `write` never take `target`.

**Why:** Pre-committing the `target` parameter keeps the public tool schema stable across the eventual sandbox change. If we add it later, every session history written before that change is inconsistent.

**Trade-off:** In MVP the model is nudged by the system prompt to always pass `target: 'host'` (or omit it, which we default to `host` when sandbox is off). This is minor noise; the benefit of stable tool shapes is larger.

### D5. Permissions are core, not a plugin

**Decision:** `GatedExecutor` wraps `LocalExecutor` when the effective `--auto-approve` is not `all`. The permission request flows through a promise-latch in the executor that the agent observes via events; `resolvePermission()` on the Agent releases the latch.

**Why:** Goal doc explicitly calls permissions "a core feature, not a plugin concern." Every consumer (TUI, SDK, future Slack harness) handles the prompt identically because it is exposed as `permission_request` / `resolvePermission` on the public surface. Making it a plugin would force each consumer to re-implement it.

**Alternative considered:** OpenCode-style `permission.request` hook. Rejected for MVP — we have no plugin system yet, and the `PermissionGate` interface is shaped so a future plugin surface can wrap around it.

### D6. HTTP + SSE over Hono, 127.0.0.1 only, no auth

**Decision:** Use Hono for the server. Bind `127.0.0.1:0` (ephemeral port), read back the actual port, write it to `~/.chimera/instances/<pid>.json`. No auth. Any network exposure is the user's problem (reverse proxy).

**Why:** Matches `spec.md` §12.3. The "same-process server + TUI" invariant from §2.1 means the server must always bind, even for `chimera` (interactive) — this is what makes `chimera attach` work against any running instance.

**Risk:** If a user runs `chimera serve` and punches a hole in their firewall, there's no auth. Mitigation: CLI prints a loud warning if `--host` is not `127.0.0.1`; default refuses to bind to anything else unless `--host 0.0.0.0` is explicit.

### D7. Events are the ONLY observable surface

**Decision:** Every state change the server has to tell clients about fires an `AgentEvent`. TUI does not poll session state; it subscribes to the SSE stream. `GET /v1/sessions/:id` exists for resume (cold read on attach) but is not in the hot path.

**Why:** Enables `chimera attach` with `sinceEventId` resume. Enables logs/replays. Enables the future subagent change to nest events verbatim via `subagent_event { event }`. Any back-channel state creates an asymmetry that breaks nesting.

### D8. Session persistence is naive JSON, not append-only JSONL

**Decision:** Write the full `Session` object to `~/.chimera/sessions/<sessionId>.json` on every `step_finished`. Overwrite, not append.

**Why:** `spec.md` §4.6 explicitly chooses this for V1 and flags "revisit if sessions exceed ~10 MB" as a V2 concern. Goal.md prefers append-only JSONL (pi-style), but that format is only necessary once we need branching / forking, which the MVP does not.

**Trade-off:** On crash mid-step the session loses at most the in-flight step. Acceptable for single-user local use.

### D9. `.chimera/permissions.json` is the only persisted rule store for MVP

**Decision:** Support session-scope (in-memory) and project-scope (`./.chimera/permissions.json`). Do not implement user-scope (`~/.chimera/permissions.json`) — `spec.md` §17 explicitly defers this.

**Why:** User-scope rules need a conflict-resolution story across multiple projects that we haven't worked through. Ship the two scopes the spec commits to, punt the third.

### D10. Machine handshake is implemented but has no in-tree caller

**Decision:** `chimera serve --machine-handshake` emits the single-line JSON on ready as `spec.md` §12.5 specifies. MVP's `spawn_agent` is absent, so nothing in this change calls it.

**Why:** It is cheap (a single `process.stdout.write` on bind) and eliminates a race at the moment subagents land. Shipping it now means the subagent change is a pure addition rather than a server-package edit.

### D11. TUI uses Ink; permission prompt is a modal overlay with scoped keybinds

**Decision:** Ink (React for terminals). Permission modal renders as an overlay that captures keybinds while active (per `spec.md` §8.5). Built-in slash commands are handled inside the TUI and never hit the server; any `/<name>` not in the built-in list errors with "unknown command" (user-template commands come in a later change).

**Why:** Matches `spec.md`. Ink is standard for this kind of UI (Claude Code itself uses it) and has a mature testing library.

### D12. Defaults deliberately echo `spec.md`

**Decision:** Defaults called out in `spec.md` are reproduced verbatim: `maxSteps: 100`, bash `timeout_ms: 120_000`, `read` limit 2000 lines or 100 KB, `--auto-approve` defaults to `host` when sandbox is off (MVP is always sandbox off). Bash refuses a hard-coded list of destructive patterns (`rm -rf /`, fork bombs, writes to `/etc`) even though the real boundary is the (not-yet-present) sandbox — per `spec.md` §6.3 "not a security boundary … just prevents dumb mistakes".

**Why:** The spec is the source of truth. Deviations compound across follow-on changes.

### D13. Logs and telemetry follow `spec.md` §16.1

**Decision:** Structured JSON lines to `~/.chimera/logs/<date>.log`. Never log API keys. Truncate tool args/results past ~4 KB. Permission decisions log in full detail.

## Risks / Trade-offs

- **[No sandbox in MVP]** → Mitigation: default `--auto-approve` is `host` (matches `spec.md` §8.1), bash refuses a destructive-pattern list (§6.3), and every tool call that goes through `GatedExecutor` is observable / cancellable via the event stream. Users who want stricter confinement wait for the sandbox change.
- **[Provider partial-compatibility surprises]** → Mitigation: `PROVIDERS.md` documents known-good combos per `spec.md` §5.4; we do not attempt detection in MVP.
- **[Session store grows unbounded]** → Mitigation: documented as a known limit (session snapshot per `step_finished`); V2/`add-compaction` addresses it.
- **[`Executor` interface has to grow when sandbox lands]** → Mitigation: already has `target()` and the full `exec/readFile/writeFile/stat/cwd` surface from `spec.md` §6.1. Adding `DockerExecutor` is then just a second implementor, not an interface edit.
- **[Permission rules without user-scope feel incomplete]** → Mitigation: documented in proposal's "explicit non-goals". Add in follow-on without breaking the rule file format (version field in the JSON reserves room).
- **[No auth on the HTTP server]** → Mitigation: bind default is `127.0.0.1`, CLI prints a warning on override; bearer-token auth is explicitly V2.

## Migration Plan

This is the first change; there is nothing to migrate from. Bootstrap:

1. `pnpm init -w`, `pnpm-workspace.yaml`, root `tsconfig.base.json`, `biome.json`, `tsup.config.ts`, `vitest.workspace.ts`.
2. Scaffold each package with `src/index.ts`, `package.json` (exports, tsup build), and the package-local `tsconfig.json` extending base.
3. Build packages bottom-up of the DAG (core → providers → tools → permissions → server → client → tui → cli) so `tsc -b` and `vitest run` pass at every step.

Rollback: `git revert` the merge commit. No external state is created until a user runs `chimera`, at which point they can delete `~/.chimera/`.

## Open Questions

- Runtime: Node.js vs. Bun? (`goal.md` defers; `spec.md` implies Node.) Default to **Node.js ≥ 20** for MVP — Bun's `child_process` edge cases around signals would eat time we should spend elsewhere.
- Config discovery: look only in `~/.chimera/config.json`, or also walk up for `.chimera/config.json`? Default to **home only** for MVP; project-scope config can come with the skills/commands change, which is where per-project settings actually matter.
- `AGENTS.md` walk: `spec.md` §4.5 says "nearest git root, else home". Implement verbatim; revisit if it surprises.
- Exit codes for `chimera run`: `spec.md` §20 suggests `0 = stop, 1 = error, 2 = max_steps, 130 = interrupted`. Adopt.
- GHCR namespace for sandbox image: **deferred with sandbox change**, not relevant to MVP.
