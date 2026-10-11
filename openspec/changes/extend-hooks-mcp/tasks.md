## 1. PreToolUse

- [x] 1.1 Test and add the `PreToolUse` event to the hook types as a pre-class event
- [x] 1.2 Test and implement the interceptor (allow, block, block with JSON, timeout)
- [x] 1.3 Wire the interceptor first in the factory's list; list the event in `chimera hooks`

## 2. Deferred MCP tools

- [ ] 2.1 Test and implement the schema size estimate and the 10% decision
- [ ] 2.2 Test and implement `tool_search` (ranking, overview, activation)
- [ ] 2.3 Test and implement `Agent.addTools`; wire deferral into MCP registration

## 3. Wrap-up

- [ ] 3.1 Update `docs/hooks.md`, `docs/mcp.md` and `README.md`
- [ ] 3.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`
