## 1. Package scaffolding

- [ ] 1.1 Add `packages/modes/` to the workspace with `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`. Dependencies: `@chimera/core` types, a minimal YAML parser (share with skills/commands if landed).
- [ ] 1.2 Define `Mode`, `ModeRegistry`, `LoadModesOptions`, and `ModeValidationError` types.
- [ ] 1.3 Publish `@chimera/modes/schema.json` with the JSON Schema for frontmatter; document the `# yaml-language-server: $schema=...` header for editors.

## 2. Discovery

- [ ] 2.1 Factor the six-tier path walker from `@chimera/skills` (or `@chimera/commands` if landed first) into a shared helper and reuse it here.
- [ ] 2.2 Scan each tier for `*.md` files; derive `name` from filename (sans `.md`).
- [ ] 2.3 Implement the implicit built-in tier backed by files bundled in `@chimera/modes/builtin/`.
- [ ] 2.4 Implement name-collision resolution with one warning per collision and reserved-name exclusion for `normal`.

## 3. Frontmatter + body parsing

- [ ] 3.1 Parse `---`-delimited YAML header; validate against the JSON Schema.
- [ ] 3.2 Treat missing optional fields as `undefined`; require `name` to match the filename stem.
- [ ] 3.3 Preserve the body verbatim (no trimming of meaningful whitespace).

## 4. Runtime validation

- [ ] 4.1 Implement tier-1 schema validation via a small Ajv (or hand-rolled) validator against the published schema.
- [ ] 4.2 Implement tier-2 tool-registry validation: check each `tools[]` entry against the session's built tool set at session start.
- [ ] 4.3 Implement tier-3 provider validation: if `model` is set, verify the providerId is in the live `ProviderRegistry`.
- [ ] 4.4 Implement tier-4 live-probe (opt-in): zero-token request to the provider endpoint; tolerate 4xx errors that name the model, fail on network errors.
- [ ] 4.5 Wire the validator into `loadModes` so excluded modes are dropped with a single warning log line per failure.
- [ ] 4.6 Unit tests: valid mode passes all four tiers; each tier's failure excludes the mode with the expected error text.

## 5. Session / core integration

- [ ] 5.1 Add `Session.mode: string | undefined` and `Session.userModelOverride: string | null` fields in `@chimera/core`; serialize both in the JSON snapshot; accept their absence during deserialization (default: `undefined` / `null`).
- [ ] 5.2 Extend `composeSystemPrompt` to append `# Current mode: <name>` + body when `session.mode` is set; pass the active mode object to the composer.
- [ ] 5.3 Implement `resolveEffectiveModel(session, mode, config)` helper covering the precedence rule; call it per step.
- [ ] 5.4 Emit `mode_changed` events with `effectiveModel` and `effectiveModelChanged` computed via the helper.
- [ ] 5.5 Implement a queued-switch slot on `Agent` (single-entry, last-writer-wins) consumed at the top of each run.
- [ ] 5.6 Unit tests: snapshot round-trip; effective-model precedence; queued switch applied between runs; mode_changed event ordering vs run lifecycle.

## 6. Tool-allowlist enforcement

- [ ] 6.1 Extend `ToolContext` with `allowlist?: Set<string>`; pass through to `buildTools`.
- [ ] 6.2 In `@chimera/core`'s step loop, compute the allowlist from the current mode and filter the tool record before passing to `streamText({ tools })`.
- [ ] 6.3 Treat `tools: []` specifically: pass an empty `{}` to streamText. Handle unexpected tool calls from the model as a tool_call_error.
- [ ] 6.4 Drop unregistered names silently with a single startup warning per mode.
- [ ] 6.5 Unit tests: omitted → all; `[]` → none (pure text); listed → exact; missing name warns once and drops.

## 7. Switching mechanics

- [ ] 7.1 Implement `Agent.setMode(name)` that validates against the session's mode registry and enqueues on the slot; emit inline "queued" if a run is in progress.
- [ ] 7.2 Drain the queued slot at the start of each `run()` call: fire `mode_changed`, update `session.mode`, persist, then proceed.
- [ ] 7.3 Resolve the effective model after a switch; include `effectiveModel` / `effectiveModelChanged` on the event.
- [ ] 7.4 Add `--mode <name>` CLI flag on `chimera`, `chimera run`, `chimera attach`; map `defaultMode` from `~/.chimera/config.json` and project config.
- [ ] 7.5 Add `cycleModes` config key (default `["normal", "plan"]`) with unknown-name-warn-and-skip.

## 8. TUI integration

- [ ] 8.1 Add `[mode:<name>]` badge to the TUI header; hide when normal; render `[mode:A → B]` while a switch is queued.
- [ ] 8.2 Implement the `/mode` built-in: `/mode` shows current; `/mode <name>` requests a switch via the client.
- [ ] 8.3 Bind `Shift+Tab` to advance through `cycleModes`; collapse rapid presses into the final destination before queuing.
- [ ] 8.4 Render an inline separator line on every `mode_changed`: `── mode: normal → plan ──`.
- [ ] 8.5 When `effectiveModelChanged` is true, also render an inline "model: <new>" line so silent switches are visible.
- [ ] 8.6 Snapshot tests for header rendering, queued badge, separator lines.

## 9. Server / SDK surface

- [ ] 9.1 Implement `POST /v1/sessions/:id/mode` with body `{ mode: string }`; respond 202 on queued, 404 with validation reason on unknown/excluded.
- [ ] 9.2 Implement `GET /v1/sessions/:id/modes` returning `Mode[]` from the session's bound registry.
- [ ] 9.3 Implement `client.setMode(sessionId, name)` surfacing 404 as `UnknownModeError`.
- [ ] 9.4 Implement `client.listModes(sessionId)` wrapping the GET.
- [ ] 9.5 Integration tests against a running server: mid-run setMode queues; resume preserves mode; listModes matches server registry.

## 10. Subagent integration (soft-dependency on `add-subagents`)

- [ ] 10.1 If `@chimera/subagents` is installed, extend the `spawn_agent` Zod schema with `mode?: string` (default omitted = normal).
- [ ] 10.2 Forward `mode` to the child via a new `--mode` arg on the `chimera serve` invocation; child's initial session-mode is set at bootstrap.
- [ ] 10.3 Unit test: plan-parent spawning default child → child is normal; explicit `mode: plan` on spawn → child is plan.

## 11. Command integration (soft-dependency on `add-commands`)

- [ ] 11.1 If `@chimera/commands` is installed, extend the frontmatter parser to recognize `mode: string` and carry it on the `Command` object.
- [ ] 11.2 At TUI command dispatch (and `chimera run --command`), when `Command.mode` is set: validate against the session's mode registry, queue the switch (emit `mode_changed { reason: "command" }`), then send the expanded template.
- [ ] 11.3 Reject invocation if the command's `mode:` names an unknown / excluded mode.
- [ ] 11.4 Unit tests: `/plan feature X` dispatches switch + message in order; unknown-mode command refuses; mode switch persists after the turn.

## 12. Built-in `plan` mode

- [ ] 12.1 Write `packages/modes/builtin/plan.md` with the frontmatter and body sketched in the design.
- [ ] 12.2 Bundle the file in the published `@chimera/modes` package exports.
- [ ] 12.3 Snapshot test: system prompt with `--mode plan` ends with the plan body verbatim; tool set is `{read}`.

## 13. CLI subcommands

- [ ] 13.1 Implement `chimera modes` (tabular + `--json`).
- [ ] 13.2 Implement `chimera modes check [--live] [--mode <name>]`; exit 1 on any warning or error; opt-in live probe.
- [ ] 13.3 Include columns: name, source, path, tools (abbreviated), model (if any), description.

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
- [ ] 15.5 E2E: Shift+Tab cycles normal → plan → normal given default `cycleModes`; `[mode:plan]` badge appears and disappears.
- [ ] 15.6 E2E: `chimera modes check` on a project with a bad provider reference exits 1 with the diagnostic.
- [ ] 15.7 E2E: `spawn_agent { mode: "plan" }` from a normal parent produces a child that shows `mode_changed { to: "plan", reason: "startup" }` as its first event.
- [ ] 15.8 E2E: `/plan some feature` command triggers `mode_changed { reason: "command" }` THEN sends the expanded message, in that order.
