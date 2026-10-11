## Why

The agent loop has three faults that affect every model. The per-step timer covers tool execution, so a tool that runs longer than `responseTimeoutMs` (120 s by default) ends the run with `timeout`. No request carries prompt-cache markers and the system prompt changes whenever the task list changes, so every step pays full input price. A provider error or an output cutoff ends the run with no recovery.

## What Changes

- `responseTimeoutMs` becomes an idle timeout: it measures model silence only and is suspended while tools run.
- The system prompt stays byte-identical across the steps of a run and across runs, except after a mode change, `/reload`, or a one-shot note. The task list leaves the system prompt; compaction writes it into the summary when the summarized region held the last `task_list` call.
- Anthropic-shape providers send cache markers on the system prompt and the last message. A per-provider `promptCaching: false` switch turns the markers off.
- The TUI usage widget shows the cached share of the last prompt.
- A step that fails with a temporary provider error is retried with backoff (maximum 4 retries), but only when no tool call started in that step. A `provider_retry` event reports each wait.
- A context-overflow error triggers one compaction and one resend of the step.
- An output cutoff with no tool calls asks the model to continue (maximum 2 times per run), then ends the run with the new reason `output_limit`. **BREAKING** for SDK clients that switch on `run_finished.reason`: a cutoff no longer reports `max_steps`.
- An optional `fallbackModel` config key: after the last retry fails, the rest of the run uses that model.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-core`: idle response timeout, stable system prompt, task list in compaction summaries, provider error recovery, output cutoff continuation, fallback model.
- `llm-providers`: prompt-cache markers for the Anthropic shape and the `promptCaching` switch.
- `token-usage-tracking`: cached share in the TUI usage widget.

## Impact

- `packages/core`: `agent.ts`, `events.ts`, `types.ts`.
- `packages/providers`: `registry.ts`, `types.ts`.
- `packages/compaction`: `compactor.ts`, `prompt.ts`.
- `packages/cli`: `config.ts`, `factory.ts`, `commands/run.ts`.
- `packages/subagents`: terminal-reason types.
- `packages/tui`: `UsageWidget.tsx`, run-finished and retry display.
- Docs: `README.md`, `docs/COMPACTION.md`, `PROVIDERS.md`.
