## Context

Skills are cheap to add because MVP reserved the exact seam they need: `composeSystemPrompt({ cwd })` exposes an extension point, `listSkills` is typed on the SDK, and `skill_activated` already exists in the `AgentEvent` union. This change is mostly discovery + text composition; no runtime complexity beyond parsing YAML safely.

## Goals / Non-Goals

**Goals:**

- Claude-compatible on discovery paths and frontmatter so that existing `.claude/skills/` trees work unchanged.
- Index is a compact text block; full SKILL.md content loads only when the model chooses to read it.
- Activation tracking is strictly observational — it changes no behavior.

**Non-Goals:**

- Skill package manager (`chimera skill add <npm|git>`) — `spec.md` §17 V1 non-goal.
- User-scope vs. project-scope conflict UX beyond a log line.
- Skills modifying the tool list dynamically (`spec.md` §9 intentionally does not do this).
- Skills-as-plugins — skills are content, not code. A later plugin-system change is separate.

## Decisions

### D1. Discovery walks up to the nearest git root, not to `/`

**Decision:** The ancestor walk starts at `cwd` and stops at the nearest `.git/` directory (or `$HOME` if no git root is found). Matches the `AGENTS.md` walk behavior from MVP.

**Why:** Consistency with the already-specified `AGENTS.md` behavior; avoids picking up a `~/.chimera/skills` that the user intended only as a user-home fallback via the ancestor path.

### D2. Name collisions log a warning; closer + Chimera-native wins

**Decision:** If two tiers produce the same skill `name`, the higher-priority tier wins and a single log line names both paths and the winner. Priority order per `spec.md` §9.2.

**Why:** Silent override hides misconfigurations; prompting the user mid-run is worse than a log line they can notice in `~/.chimera/logs/`.

### D3. Index injection is append-only to the system prompt

**Decision:** `composeSystemPrompt` appends the skill-index block after any `AGENTS.md` content. The block starts with a stable literal header ("`# Available skills`") so the model prompt is idempotent.

**Why:** Appending means we don't have to parse the pre-composed prompt. The stable header lets the model learn to recognize the block.

### D4. Activation detection compares resolved absolute paths

**Decision:** Maintain an in-memory set of absolute SKILL.md paths at session start. On each `tool_call_result` for `read`, resolve the read path against cwd and consult the set — on a hit, emit `skill_activated`.

**Why:** Activation is a side-effect of reading; we do not want to intercept the tool or change its behavior. Path-based detection is the least invasive.

**Trade-off:** If the model `read`s the SKILL.md for reasons unrelated to using the skill (copy/paste, debugging), we still emit `skill_activated`. Per `spec.md` §9.5, that is acceptable — the event is purely informational.

### D5. Frontmatter parse errors are soft failures

**Decision:** A SKILL.md with invalid or missing required frontmatter is excluded from the registry with a log line; discovery does not error out.

**Why:** A single broken skill should not prevent the session from starting.

## Risks / Trade-offs

- **[Large skill trees slow session start]** → Discovery walks are bounded by git root; reading frontmatter is O(#skills) with small files. If users accumulate hundreds, revisit.
- **[Duplicate names across Chimera and Claude-compat]** → Log a warning; documented behavior.
- **[SKILL.md bundled scripts path drift]** → Skills reference scripts via relative paths inside their own directory. `read`/`bash` in the agent handle this naturally; no special support needed.

## Migration Plan

Additive. Existing users with `.claude/skills/` trees get them auto-discovered the first time they upgrade and run Chimera. Opt out per-session with `--no-skills` or `--no-claude-compat`, or globally via `config.json`.

## Open Questions

- Should `chimera skills` support a `--json` flag for tooling? Proposed: yes, trivially.
- Should we warn the user in the TUI at session start when skills are discovered? Proposed: no — index injection alone is sufficient, the TUI already shows the activation badge when a skill is actually used.
