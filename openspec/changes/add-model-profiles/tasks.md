## 1. Profile resolution

- [ ] 1.1 Test and implement `resolveModelProfile` (family rules, overrides, output budget)
- [ ] 1.2 Add `editFormat` and `promptStyle` to `ModelConfig` and to `models.<ref>` config

## 2. Generated tools section and prompt styles

- [ ] 2.1 Add `promptSnippet` to tool definitions and return snippets from `buildTools`
- [ ] 2.2 Test and implement the generated `## Tools` section in `composeSystemPrompt`
- [ ] 2.3 Test and implement the `guided` working-method section
- [ ] 2.4 Remove the fixed tool text from `ROLE_PROMPT` and the codex branch from the factory

## 3. Codex shape parity

- [ ] 3.1 Test and implement: the codex shape keeps every tool and passes `run_in_background`
- [ ] 3.2 Test and implement allowlist aliases

## 4. apply_patch

- [ ] 4.1 Add `Executor.removeFile` to the interface and the three executors
- [ ] 4.2 Test and implement the patch parser
- [ ] 4.3 Test and implement hunk location and atomic application
- [ ] 4.4 Register `apply_patch` for `editFormat: "patch"`, with diagnostics and a scrollback summary
- [ ] 4.5 Track `apply_patch` file operations in the agent and render patches in the TUI

## 5. Wiring

- [ ] 5.1 Resolve the profile in the CLI factory and build tools and prompt from it
- [ ] 5.2 Apply the new model's profile on `/model` changes

## 6. Wrap-up

- [ ] 6.1 Update `README.md`, `PROVIDERS.md` and `docs/MODES.md`
- [ ] 6.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`
