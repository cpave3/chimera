## 1. Package scaffolding

- [x] 1.1 Add `packages/modes/` to the workspace with `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`. Dependencies: `@chimera/core` types, a minimal YAML parser (share with skills/commands if landed).
- [x] 1.2 Define `Mode`, `ModeRegistry`, `LoadModesOptions`, and `ModeValidationError` types. `Mode` carries `colorHex: string` (always set) plus optional raw `color` from frontmatter.
- [ ] 1.3 Publish `@chimera/modes/schema.json` with the JSON Schema for frontmatter (including `color`); document the `# yaml-language-server: $schema=...` header for editors.
- [x] 1.4 Implement `colorFor(name, override?)` helper: parse `#rgb`/`#rrggbb` override; otherwise FNV-1a hash → hue → HSL(s=65%, l=55%) → hex. Pure function. Unit tests: deterministic, distinct outputs for distinct names, valid override passes through, invalid override falls back with a warning sentinel return.

## 2. Discovery

- [ ] 2.1 Factor the six-tier path walker from `@chimera/skills` (or `@chimera/commands` if landed first) into a shared helper and reuse it here.
- [x] 2.2 Scan each tier for `*.md` files; derive `name` from filename (sans `.md`).
- [x] 2.3 Implement the implicit built-in tier backed by files bundled in `@chimera/modes/builtin/`.
- [x] 2.4 Implement name-collision resolution with one warning per collision. (No reserved names — `build` and `plan` are real shipped files that users may override by name.)

## 3. Frontmatter + body parsing

- [x] 3.1 Parse `---`-delimited YAML header; validate against the JSON Schema. Recognize `tools` (array, supports inline `[a, b]` and block list), `model`, `color` in addition to `name`/`description`.
- [x] 3.2 Treat missing optional fields as `undefined`; require `name` to match the filename stem.
- [x] 3.3 Preserve the body verbatim (no trimming of meaningful whitespace).
- [x] 3.4 Resolve `colorHex` per mode at load time via `colorFor(name, frontmatter.color)`; on invalid `color:` log one warning and use the derived value.

## 4. Runtime validation

- [ ] 4.1 Implement tier-1 schema validation via a small Ajv (or hand-rolled) validator against the published schema.
- [ ] 4.2 Implement tier-2 tool-registry validation: check each `tools[]` entry against the session's built tool set at session start.
- [ ] 4.3 Implement tier-3 provider validation: if `model` is set, verify the providerId is in the live `ProviderRegistry`.
- [ ] 4.4 Implement tier-4 live-probe (opt-in): zero-token request to the provider endpoint; tolerate 4xx errors that name the model, fail on network errors.
- [ ] 4.5 Wire the validator into `loadModes` so excluded modes are dropped with a single warning log line per failure.
- [ ] 4.6 Unit tests: valid mode passes all four tiers; each tier's failure excludes the mode with the expected error text.

## 5. Session / core integration

- [x] 5.1 Add `Session.mode: string` (defaults to `"build"`) and `Session.userModelOverride: string | null` fields in `@chimera/core`; serialize both in the JSON snapshot; accept their absence during deserialization (default: `"build"` / `null`).
- [x] 5.2 Extend `composeSystemPrompt` to append `# Current mode: <name>` + body when `session.mode` is set; pass the active mode object to the composer.
- [x] 5.3 Implement `resolveEffectiveModel(session, mode, config)` helper covering the precedence rule; call it per step. (Inline in factory.ts; not factored into a named helper yet.)
- [x] 5.4 Emit `mode_changed` events with `effectiveModel` and `effectiveModelChanged` computed via the helper.
- [x] 5.5 Implement a queued-switch slot on `Agent` (single-entry, last-writer-wins) consumed at the top of each run; idle queue calls drain immediately.
- [ ] 5.6 Unit tests: snapshot round-trip; effective-model precedence; queued switch applied between runs; mode_changed event ordering vs run lifecycle.
- [ ] 5.7 Persist `mode_changed` across session resume so the TUI scrollback can show prior "Mode change: A → B" lines after `chimera --resume`. Today the line is rendered live (App.tsx mode_changed handler) but is lost on restart — `Session.mode` is persisted (chrome reflects current mode correctly) but the transition history isn't. Steps: (a) add `mode_changed` to the `PersistedEvent` union in `packages/core/src/events.ts`; (b) persist via `appendSessionEvent` in both drain paths (the `runInternal` queued drain in `agent.ts` and the idle-apply path in the server's POST `/v1/sessions/:id/mode` handler); (c) extend `Scrollback.rehydrateFromSession` (or add a sibling event-replay pass) to read `events.jsonl` and re-emit info lines for any persisted `mode_changed` entries.

## 6. Tool-allowlist enforcement

- [ ] 6.1 Extend `ToolContext` with `allowlist?: Set<string>`; pass through to `buildTools`. (Filtering is currently applied in factory.ts via `applyAllowlist` instead.)
- [x] 6.2 In `@chimera/core`'s step loop, compute the allowlist from the current mode and filter the tool record before passing to `streamText({ tools })`.
- [x] 6.3 Treat `tools: []` specifically: pass an empty `{}` to streamText. Handle unexpected tool calls from the model as a tool_call_error.
- [x] 6.4 Drop unregistered names silently with a single startup warning per mode.
- [ ] 6.5 Unit tests: omitted → all; `[]` → none (pure text); listed → exact; missing name warns once and drops.

## 7. Switching mechanics

- [x] 7.1 Implement `Agent.setMode(name)` that validates against the session's mode registry and enqueues on the slot; emit inline "queued" if a run is in progress. (Exposed as `queueModeSwitch`; idle calls apply immediately and return the resolved mode_changed payload so the server can publish on the bus.)
- [x] 7.2 Drain the queued slot at the start of each `run()` call: fire `mode_changed`, update `session.mode`, persist, then proceed.
- [x] 7.3 Resolve the effective model after a switch; include `effectiveModel` / `effectiveModelChanged` on the event.
- [x] 7.4 Add `--mode <name>` CLI flag on `chimera`, `chimera run`, `chimera attach`; map `defaultMode` from `~/.chimera/config.json` and project config. (Project-config walk deferred — see §14.)
- [x] 7.5 Add `cycleModes` config key (default `["build", "plan"]`) with unknown-name-warn-and-skip.

## 8. TUI integration

- [x] 8.1 Add `[mode:<name>]` widget to the TUI **bottom status bar** (left side of existing chrome rows). Always visible. Tint the mode name with `mode.colorHex`. While a switch is queued, render `[mode:A → B]` with each name tinted with its own resolved color.
- [x] 8.2 Implement the `/mode` built-in: `/mode` shows current; `/mode <name>` requests a switch via the client.
- [x] 8.3 Bind `Shift+Tab` to advance through `cycleModes`; collapse rapid presses into the final destination before queuing.
- [x] 8.4 Mode transitions are reflected only in the bottom status-bar widget; no scrollback line is added on `mode_changed`. (Revision: original spec called for `── mode: build → plan ──` but the chrome already conveys the state.)
- [x] 8.5 No "model: <new>" line on `effectiveModelChanged` either — same reasoning. (`/model` will continue to surface explicit user-driven model changes.)
- [ ] 8.6 Snapshot tests for status-bar rendering, queued widget, separator lines.

## 9. Server / SDK surface

- [x] 9.1 Implement `POST /v1/sessions/:id/mode` with body `{ mode: string }`; respond 202 on queued, 404 with validation reason on unknown/excluded.
- [x] 9.2 Implement `GET /v1/sessions/:id/modes` returning `Mode[]` from the session's bound registry.
- [x] 9.3 Implement `client.setMode(sessionId, name)` surfacing 404 as `UnknownModeError`. (404 currently surfaces as a generic Error; typed `UnknownModeError` follow-up.)
- [x] 9.4 Implement `client.listModes(sessionId)` wrapping the GET.
- [ ] 9.5 Integration tests against a running server: mid-run setMode queues; resume preserves mode; listModes matches server registry.

## 10. Subagent integration (soft-dependency on `add-subagents`)

- [ ] 10.1 If `@chimera/subagents` is installed, extend the `spawn_agent` Zod schema with `mode?: string` (default omitted = `"build"`).
- [ ] 10.2 Forward `mode` to the child via a new `--mode` arg on the `chimera serve` invocation; child's initial session-mode is set at bootstrap.
- [ ] 10.3 Unit test: plan-parent spawning default child → child is `build`; explicit `mode: plan` on spawn → child is `plan`.

## 11. Command integration (soft-dependency on `add-commands`)

- [ ] 11.1 If `@chimera/commands` is installed, extend the frontmatter parser to recognize `mode: string` and carry it on the `Command` object.
- [ ] 11.2 At TUI command dispatch (and `chimera run --command`), when `Command.mode` is set: validate against the session's mode registry, queue the switch (emit `mode_changed { reason: "command" }`), then send the expanded template.
- [ ] 11.3 Reject invocation if the command's `mode:` names an unknown / excluded mode.
- [ ] 11.4 Unit tests: `/plan feature X` dispatches switch + message in order; unknown-mode command refuses; mode switch persists after the turn.

## 12. Built-in `build` and `plan` modes

- [x] 12.1 Write `packages/modes/builtin/build.md` (default mode; no tool allowlist; concise body) and `packages/modes/builtin/plan.md` (read-only; `tools: [read]`; planning body) with the frontmatter sketched in the design.
- [x] 12.2 Bundle both files in the published `@chimera/modes` package exports.
- [ ] 12.3 Snapshot test: system prompt with `--mode plan` ends with the plan body verbatim; tool set is `{read}`. Default `--mode build` (or no flag) ends with the build body and tool set is unchanged.

## 13. CLI subcommands

- [ ] 13.1 Implement `chimera modes` (tabular + `--json`).
- [ ] 13.2 Implement `chimera modes check [--live] [--mode <name>]`; exit 1 on any warning or error; opt-in live probe.
- [ ] 13.3 Include columns: name, source, path, tools (abbreviated), model (if any), color, description.

## 14. Project-level config (soft dependency pulled into this change)

- [ ] 14.1 Extend `@chimera/cli`'s config loading to walk from cwd toward git root for `.chimera/config.json`, merging over `~/.chimera/config.json`.
- [ ] 14.2 Clarify precedence: flags > env > project config > user config (matches MVP's flag/env/file order, extended).
- [ ] 14.3 Allow `providers`, `defaultMode`, `cycleModes`, and future keys to be set per-project.
- [ ] 14.4 Tests: project-scope provider config enables a mode that would otherwise fail validation at the user scope.

## 15. Documentation / E2E

- [ ] 15.1 Write `MODES.md`: authoring, discovery precedence, frontmatter schema, switching, Shift+Tab cycle, plan mode example, subagent / command interactions.
- [ ] 15.2 Update `README.md` with a short modes intro and a `/mode plan` demo.
- [ ] 15.3 E2E: `chimera run --mode plan "how would we add X"` produces a plan in assistant output and exits `reason: "stop"`.
- [ ] 15.4 E2E: interactive session `/mode plan` → agent replies with a plan → `/mode normal` → next turn executes using the plan as context.
- [ ] 15.5 E2E: Shift+Tab cycles build → plan → build given default `cycleModes`; the status-bar `[mode:plan]` widget changes color along with the name.
- [ ] 15.6 E2E: `chimera modes check` on a project with a bad provider reference exits 1 with the diagnostic.
- [ ] 15.7 E2E: `spawn_agent { mode: "plan" }` from a `build`-mode parent produces a child that shows `mode_changed { to: "plan", reason: "startup" }` as its first event.
- [ ] 15.8 E2E: `/plan some feature` command triggers `mode_changed { reason: "command" }` THEN sends the expanded message, in that order.
