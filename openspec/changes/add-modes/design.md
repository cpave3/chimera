## Context

`spec.md` §17 deferred plan mode as a V1 non-goal. The conversation that shaped this change rejected the obvious "ship `--plan` as a flag" reading in favor of a more ambitious framing: **modes** as a Vim-like primitive, with plan mode as the first instance. The Vim analogy is load-bearing — it sets the expectation that modes are *what the agent can see and do right now*, not a catch-all for "how the agent behaves". Kept narrow, modes become a small, composable extension. Kept broad, they become a permissions-plus-personality-plus-config mush that fights everything else.

## Goals / Non-Goals

**Goals:**

- Mode is a file-based primitive consistent with skills and commands — same discovery, same Claude-compat story, same ecosystem.
- Plan mode falls out as a specific file, not as hardcoded special-case behavior.
- Switching is safe and predictable: mid-run switches queue, user-typed model overrides stick across switches, broken modes fail loudly on use but quietly on discovery.
- Composes cleanly with subagents, commands, and skills without creating cross-primitive rules (skill requires-mode, command forces-mode as a hidden side effect, etc.).

**Non-Goals:**

- Mode controls permissions, sandbox mode, temperature, max-steps, or compaction config. Those are orthogonal and stay orthogonal.
- Mode is reachable by model self-determination (e.g. a "switch to X mode" tool). Modes are *user governance*, not model output.
- A stackable/composable mode system (multiple modes active at once). Vim has one mode at a time; so do we.
- Hard denylists, wildcards, or tags in the tool allowlist. Exact names only.
- TS/JS file format. Markdown + YAML + JSON Schema covers the typesafety we want without the trust-boundary shift.

## Decisions

### D1. Four fields per mode: prompt fragment, tool allowlist, optional model override, optional color

**Decision:** A Mode has exactly `{ name, description, body, tools?, model?, color? }`. Nothing else. `body` is the markdown after the YAML frontmatter; `tools` is a `string[]` allowlist; `model` is a `providerId/modelId` string; `color` is a CSS hex used by the TUI mode indicator (with a deterministic name-derived fallback when absent).

**Why:** The abstraction has to stay narrow to survive. Each additional knob (temperature, sandbox, permissions overlay, compaction config) multiplies the surface and creates cross-cutting concerns ("does switching modes re-apply all of these?"). Vim's modes change what keys mean; they don't also change your colorscheme. Our modes change the agent's directive and toolset — no more.

**Alternative considered:** model + temperature + max-steps. Rejected — users who want per-mode tuning can define a project-level config the mode references, or just switch models.

### D2. Markdown + YAML + JSON Schema, not TS/JS

**Decision:** Mode files are markdown with YAML frontmatter. Typesafety comes from (a) a published JSON Schema for the frontmatter, (b) a runtime validator that checks tool names and provider IDs against the live registry, and (c) a `chimera modes check` command.

**Why:** A mode is declarative config (three fields, one of which is prose). TS gains would be narrow (tool-name autocomplete) and come at real costs (trust boundary — arbitrary code executes on session start when you clone a repo, loader complexity, inconsistency with skills/commands which ARE markdown, breakage of PR review ergonomics). OpenCode plugins are TS because plugins execute behavior; modes don't.

**Alternative considered:** allow both `.md` and `.ts`. Rejected — doubles surface with no clear win.

### D3. Six-tier discovery, shared with skills and commands

**Decision:** Tiers, priority-ordered: `<cwd>/.chimera/modes/`, ancestors up to git root, `~/.chimera/modes/`, then `.claude/modes/` mirrors (opt-out via `--no-claude-compat`). Higher tier wins on name collision, with one log warning per collision. Built-in `plan.md` sits at a seventh implicit tier inside `@chimera/modes/builtin/` so users override it by dropping their own into any higher tier.

**Why:** Consistency. If the user already learned skill / command discovery, they already know mode discovery. The walker is factored to one shared helper.

**No `normal` sentinel.** Earlier drafts treated "no mode active" as the implicit `normal` state. The shipping design instead bundles a real `build` mode as the default. The session's `mode` is always a string (defaulting to `"build"`), the system prompt always carries a `# Current mode:` block, and the TUI always shows a mode badge with a color. This trades one extra (benign) line in the system prompt for: a uniform code path (no `mode === undefined` branches), a discoverable default mode users can override, and a status-bar that always tells the user where they are.

### D4. Validation: warn-on-discovery, error-on-use

**Decision:** At session start (after all plugins / tools register), discover all modes and validate each against (a) JSON Schema, (b) tool registry, (c) provider registry. Modes failing any of these are *excluded* from the registry with a warning log. Attempts to *use* an excluded mode (configured default, `/mode <excluded>`, Shift+Tab landing on it) error with the original failure reason.

**Why:** A broken mode in the home directory shouldn't break unrelated sessions. But silent fallback on use is worse than loud failure. "Warn to log, error to user" hits both.

**Live model probe is opt-in** via `chimera modes check --live` — it costs a provider request, so we don't do it at every session start.

### D5. Append composition, literal headers

**Decision:** The mode's body is appended to the system prompt after any AGENTS.md and skill-index blocks, preceded by the literal line `# Current mode: <name>`. Mode switches re-compose by slicing off everything from `# Current mode:` onward and appending the new block.

**Why:** Append puts the current directive at the end of the prompt — recency bias works in the model's favor. Literal headers make parsing trivial. Keeping the role prompt and AGENTS.md in place means mode authors don't have to re-invent tool-use conventions.

### D6. Exact-names allowlist, registration-time enforcement

**Decision:** `tools:` is an array of exact tool names. Omitted = all tools registered; `[]` = no tools registered (pure-text mode); listed = exactly those. Unregistered tool names in the list warn and drop. Enforcement happens at `streamText({ tools })` so the model never sees schema entries for disallowed tools.

**Why:** Explicit allowlists future-proof against new mutating tools (plan.md from a year ago shouldn't silently start allowing a freshly-added `delete` tool). Registration-time enforcement prevents the model from trying tools that will always be denied — no wasted rounds.

### D7. Queued switching with mid-run interrupt

**Decision:** Mode switches requested via `/mode`, Shift+Tab, or `POST /v1/sessions/:id/mode` are queued — the next call to `Agent.run()` drains the queue, recomposes the system prompt, filters tools, and emits `mode_changed`. When a switch is requested mid-run, the TUI ALSO issues `interrupt()` so the active run terminates promptly; the queued switch then lands at the top of the user's next message.

**Why (revised):** The original design left mid-run switches purely queued, which felt sluggish — a five-step plan the model was working on would have to complete before the user's `/mode plan` took effect. The user's feedback was: "tokens currently streaming can't be helped, but we should switch mode at the earliest sane opportunity." The realistic compromise is to interrupt the run; the model loses the rest of its current plan but the user's next message starts in the new mode immediately. A finer-grained "swap mode at the next streamText step boundary" would require Chimera to drive its own step loop instead of delegating to the AI SDK's stopWhen orchestration, which is out of scope for this change.

**Why we don't recompose silently mid-stream:** the AI SDK's multi-step orchestration runs internally inside `streamText` once we call it. There is no clean hook to swap `system` or `tools` between SDK-managed steps. Aborting + restarting is the cleanest available primitive; doing so explicitly (with a visible interrupt notice in scrollback) is honest about what happened.

### D8. `Session.userModelOverride` is sticky; mode.model is a soft default

**Decision:** Effective model per call = `Session.userModelOverride ?? currentMode.model ?? config.defaultModel`. CLI `-m` and mid-session `/model X` both write to `userModelOverride`. It stays set across mode switches until cleared with `/model default`.

**Why:** When a user explicitly said "use model X", they mean it. Silently swapping to a mode's cheaper model because they glanced at plan mode would be surprising. Mode.model is the author's intent for zero-config users; user intent always wins over author intent.

**Event carries the effective model** — `mode_changed { ..., effectiveModel, effectiveModelChanged }` — so the TUI can flash "now using claude-haiku-4" when a switch actually changes the model. Prevents silent swaps.

### D9. Shift+Tab cycles a config-driven list

**Decision:** `cycleModes` in config is an ordered list of mode names. When unset, the cycle defaults to **every discovered mode** (alphabetical). When set, exactly that list is used (unknown names warn and skip). Shift+Tab advances forward; wraps; forward-only in V1.

**Why:** Earlier the default was `["build", "plan"]`, which surprised users who dropped `~/.chimera/modes/question.md` and expected Shift+Tab to find it. Defaulting to "every mode" means the keybind picks up user-authored modes for free; the explicit-list form is reserved for users who actively want a smaller cycle. Cycle membership stays a presentation concern — lives in config, not in mode frontmatter. Direct `/mode <name>` access still works regardless of cycle membership.

### D10. Subagents default to build, not parent's mode

**Decision:** `spawn_agent` takes an optional `mode?: string` param. Default is `"build"`. Parent's mode is not inherited.

**Why:** Mode is task intent, not environment. A plan-mode parent spawning a child almost always means "I've planned, now YOU execute" — inheriting plan would be subtly wrong. Making the default `build` and the override explicit means `spawn_agent` reads honestly: "do this task as a build-mode agent, unless I specify otherwise."

### D11. Commands can switch modes persistently; skills cannot

**Decision:** Command frontmatter gains optional `mode: string`. When invoked, the mode switch is queued (via the same machinery as `/mode`) before the expanded message is sent. Skills have no mode interaction — not frontmatter `suggestedMode`, not `requiredMode`.

**Why:** Commands are user-invoked — adding a `mode:` field is an opt-in by the command author for a workflow-command pattern (`/plan this feature` switches to plan AND sends the request). Skills are model-invoked — giving them mode power crosses the "modes are user governance" line. A skill author who wants to recommend a mode can write it in the SKILL.md body; the human reads it.

## Risks / Trade-offs

- **[Users who want mode-aware per-model routing across all modes feel constrained.]** Mitigation: `model:` per-mode covers zero-config; `--model` + `/model` cover active overrides. If users need more (e.g., "plan mode uses Haiku unless a specific project overrides"), that's a project-config-layered-over-user-config story that `add-skills`/`add-commands` already wanted and is part of the project-level config work.
- **[Mode + command double-switch races.]** Mitigation: queue is a single-slot last-writer-wins. If a user types `/mode review`, then immediately invokes a command with `mode: plan`, the queued switch is plan. Simple and predictable.
- **[Built-in plan.md shipping as the "right" plan mode prescribes an opinion.]** Mitigation: `~/.chimera/modes/plan.md` overrides. Ship the opinion; document the override path.
- **[Headless `chimera run --mode plan` has no execute-phase story.]** Intentional. Headless is one-shot; users chain two invocations (or run interactively) for plan-then-execute.
- **[Mode is not reachable from model output, so the model can't "finish planning and switch itself."]** Intentional. Modes are governance; self-switching models defeats the point. "Plan ready for review." sentence in plan.md's body is a convention the human reads, not a tool call.

## Migration Plan

Additive. Sessions created before this change deserialize with `mode: "build"` (the new default) and `userModelOverride: null`. Users who haven't authored any modes still get the bundled `build` and `plan` builtins; behavior is effectively unchanged for `build` (no tool allowlist, near-no-op body) and `/mode plan` flips the session into the plan-mode preset. Rollback: `git revert`; `Session.mode` and `userModelOverride` fields become dead but harmless in persisted sessions.

## Decisions added in revision

### D12. Bottom status bar, not header

**Decision:** The TUI mode indicator lives in the existing bottom status bar (left side of the existing chrome rows), not in the top header. Always visible, always colored.

**Why:** The header is reserved for cwd / model / context-window information that is critical at the start of a session. The bottom status bar is the persistent ambient surface — same place users already look for status indicators (cwd, model). A mode indicator that is always visible there reinforces "you are always in some mode" and gives the color a steady visual anchor.

### D13. Color is per-mode and deterministic by default

**Decision:** Mode frontmatter takes an optional `color: <hex>`. When absent, the runtime derives a deterministic color from the mode name (FNV-1a hash → hue, fixed S/V) so every mode automatically has a stable, distinct color. The same helper is reused by `chimera modes` listings and any future surface that wants to brand a mode.

**Why:** Color is the cheapest way to make "I'm in plan vs build" visible at a glance. Forcing every mode author to pick a color is friction; falling back to grey loses the signal. Deterministic derivation gives users distinct colors for free; explicit `color:` lets them tune for muscle memory or accessibility.

## Open Questions

- **Project-level config** (`<project>/.chimera/config.json`) is a soft dependency for shareable modes whose `model:` references a non-default provider. Should the `add-modes` change pull that in, or ship modes first and make project config a separate follow-on? Proposed: **ship project config as part of this change** — `cycleModes` also wants to be project-overridable, and a team shipping `.chimera/modes/plan.md` should be able to ship `.chimera/config.json` alongside.
- **Reverse-cycle keybind.** Skipped in V1. Reconsider if 3+ mode cycles become common.
- **Mode transitions that change compaction behavior.** Compaction runs based on `reserveTokens` / `keepRecentTokens`; mode switch doesn't trigger compaction. If a user wants to "reset context when switching to plan," they manually `/compact`. Revisit if users ask for automatic.
