## Why

Chimera gives every model the same prompt and the same tools. The role prompt says there are four built-in tools when up to fourteen are registered. The `codex` tool-call shape silently drops `fetch`, `web_search`, `task_list`, `recall`, `bash_output` and `bash_kill`, and gives GPT models an exact-string `edit` tool instead of the `apply_patch` format they are trained on. Small models get no extra guidance. Mode allowlists written with native tool names lose `glob` under the `codex` shape.

## What Changes

- Each model resolves to a **profile**: `toolCallShape` (existing), `editFormat` (`replace` or `patch`), `promptStyle` (`lean` or `guided`), and an output budget in tokens derived from the context window. Resolution order: the model's entry in `config.json`, a built-in table of known model families, defaults.
- The tools section of the system prompt is generated from the registered tools. Each tool definition carries a one-line `promptSnippet`. The fixed tool text in the role prompt and the `codex`-only tool list are removed.
- The `guided` prompt style adds a short working-method section for models that need explicit rules.
- The `codex` tool-call shape keeps every tool and passes `run_in_background` through.
- A new `apply_patch` tool implements the Codex patch format (add, update, delete, move). It replaces `edit` when `editFormat` is `patch`.
- Mode allowlists use native tool names for every shape: `glob` also admits `find` and `ls`, `edit` also admits `apply_patch`.
- A `/model` change applies the new model's profile (tools, prompt) on the next run. **BREAKING**: previously the tool surface of the first model stayed for the whole session.
- `Executor` gains `removeFile`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `llm-providers`: model profile resolution.
- `tool-execution`: `apply_patch`, `codex` shape parity, tool prompt snippets, allowlist aliases, `Executor.removeFile`.
- `agent-core`: generated tools section and prompt styles in system prompt composition.

## Impact

- `packages/providers`: new `model-profile.ts`.
- `packages/core`: `prompts/`, `types.ts` (`ModelConfig`), `interfaces.ts` (`Executor`), `agent.ts` (file tracking for `apply_patch`).
- `packages/tools`: `apply-patch.ts`, `codex-adapter.ts`, `build.ts`, `define.ts`, every tool definition (snippet), `local-executor.ts`.
- `packages/sandbox`, `packages/permissions`: `removeFile` on `DockerExecutor` and `GatedExecutor`.
- `packages/cli`: `factory.ts`, `config.ts`.
- `packages/modes`: allowlist aliases.
- `packages/tui`: `ToolBody.tsx` renders patches.
- Docs: `README.md`, `PROVIDERS.md`, `docs/MODES.md`.
