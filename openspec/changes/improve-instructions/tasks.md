## 1. Instruction files

- [ ] 1.1 Test and implement the 32 KiB limit in prompt composition
- [ ] 1.2 Remove the role prompt sentence about reading `AGENTS.md`
- [ ] 1.3 Test and implement the nested instructions interceptor
- [ ] 1.4 Wire the interceptor into the factory; pass cut-file notices to the TUI

## 2. Skill index

- [ ] 2.1 Test and implement the index token limit
- [ ] 2.2 Pass 2% of the context window from the factory

## 3. Plan mode

- [ ] 3.1 Test and implement the `name(limit)` syntax in mode files
- [ ] 3.2 Test and implement the agent limit in `spawn_agent`
- [ ] 3.3 Update the built-in plan mode; wire the active mode's limit

## 4. Wrap-up

- [ ] 4.1 Update `README.md` and `docs/MODES.md`
- [ ] 4.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`
