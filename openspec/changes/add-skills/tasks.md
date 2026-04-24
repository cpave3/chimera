## 1. Package scaffolding

- [ ] 1.1 Add `packages/skills/` to the workspace (`package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`). Dependencies: `@chimera/core` types, `js-yaml` or equivalent minimal YAML parser.
- [ ] 1.2 Define `Skill`, `SkillRegistry`, and `LoadSkillsOptions` types per the spec.

## 2. Discovery

- [ ] 2.1 Implement git-root detection helper (reused from `@chimera/core`'s `AGENTS.md` walk if possible).
- [ ] 2.2 Implement the six-tier path search with correct priority and ancestor walk bounded at git root.
- [ ] 2.3 Implement collision resolution: higher tier wins; log one warning per collision.
- [ ] 2.4 Support `includeClaudeCompat: false` — skip tiers 4–6 entirely.

## 3. Frontmatter parsing

- [ ] 3.1 Parse `---`-delimited YAML block from the top of each SKILL.md.
- [ ] 3.2 Validate required fields (`name` matches dir name, `description` non-empty); skip-with-warning otherwise.
- [ ] 3.3 Preserve optional fields in a raw `frontmatter` object for future consumers.

## 4. Index generation

- [ ] 4.1 Implement `SkillRegistry.buildIndex()` producing the `# Available skills` block.
- [ ] 4.2 Return empty string when registry is empty.
- [ ] 4.3 Unit tests: ordering stability across runs (sort by name), correct inclusion of `path`.

## 5. Activation tracking

- [ ] 5.1 Thread the skill registry into `ToolContext`.
- [ ] 5.2 In the `read` tool, after a successful read, resolve the absolute path and check the registry set; emit `skill_activated` on a hit.
- [ ] 5.3 Ensure the event fires only once per SKILL.md per session — or document that multiple reads produce multiple events (simpler). Pick the simpler option; document.
- [ ] 5.4 Unit test: `read` of a skill path fires `skill_activated`; `read` of a non-skill path does not.

## 6. Core integration

- [ ] 6.1 Update `@chimera/core`'s `composeSystemPrompt` to accept and append the skill index (using the MVP-reserved extension point).
- [ ] 6.2 Update call sites (CLI, in-process subagent path) to pass the index.
- [ ] 6.3 Unit test: empty registry → no header; non-empty → header present, correct order.

## 7. CLI

- [ ] 7.1 Parse `--no-skills` and `--no-claude-compat`; honor `skills.enabled` and `skills.claudeCompat` config keys.
- [ ] 7.2 Call `loadSkills` at session start (unless `--no-skills`); pass registry to the Agent.
- [ ] 7.3 Implement `chimera skills` subcommand with tabular and `--json` output.

## 8. Server / Client

- [ ] 8.1 Implement `GET /v1/sessions/:id/skills` returning `registry.all()` from the session's bound registry.
- [ ] 8.2 Implement `client.listSkills(sessionId)` — typed in MVP, now wired.

## 9. TUI

- [ ] 9.1 On `skill_activated`, attach a `📚 skill: <name>` badge to the nearest preceding `tool_call_start` row (the `read` that triggered it).
- [ ] 9.2 Snapshot test: tool-call row rendering with and without skill activation.

## 10. Documentation / E2E

- [ ] 10.1 Write `SKILLS.md` showing how to author a SKILL.md, discovery path precedence, and tips on bundled scripts.
- [ ] 10.2 E2E: project with one `.chimera/skills/foo/SKILL.md` → system prompt contains `# Available skills`, `chimera skills` lists it, `read` fires activation.
- [ ] 10.3 E2E: name collision between `.chimera` and `.claude` tiers → registry prefers `.chimera`, log contains the warning line.
- [ ] 10.4 E2E: `--no-skills` → no discovery, no prompt injection, no activation events.
