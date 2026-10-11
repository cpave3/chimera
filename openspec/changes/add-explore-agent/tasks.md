## 1. Explore agent

- [x] 1.1 Test and implement discovery of built-in agent definitions
- [x] 1.2 Write `builtin/explore.md`; ship it in the package
- [x] 1.3 Test and implement the `utility` model alias in `spawn_agent`

## 2. Utility model

- [x] 2.1 Test and add the `utilityModel` config key and the compaction fallback
- [x] 2.2 Wire the key into the factory; warn when it cannot be resolved
- [x] 2.3 Test and add the explore guidance to the prompt's tool list

## 3. Background children

- [x] 3.1 Test and implement `AgentRegistry.deliver` (queue during a run, start a run when idle)
- [x] 3.2 Test and implement the background manager and `background: true`
- [x] 3.3 Test and implement `agent_status` and `agent_stop`; stop children at session end
- [x] 3.4 Test and implement the transcript lines

## 4. Wrap-up

- [x] 4.1 Update `README.md` and `docs/`
- [x] 4.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`; subagent E2E with `CHIMERA_TEST_E2E=1`
