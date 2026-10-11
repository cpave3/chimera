## 1. Idle response timeout

- [x] 1.1 Test: a tool slower than `responseTimeoutMs` completes and the run ends with `stop`
- [x] 1.2 Make the step timer restart on each stream part and pause while tools run
- [x] 1.3 Confirm the silent-model and `0`-disables tests still pass

## 2. Stable system prompt

- [x] 2.1 Test: two steps of one run send the same system prompt after a task list update
- [x] 2.2 Remove the task list from `Agent.composeSystemPrompt`
- [x] 2.3 Test and implement the `<tasks>` block in compaction summaries

## 3. Prompt cache markers

- [x] 3.1 Test: Anthropic-shape request body carries `cache_control` on system and last message
- [x] 3.2 Add the markers in the Anthropic provider middleware
- [x] 3.3 Test and implement `promptCaching: false`; confirm the OpenAI shape sends no marker
- [x] 3.4 Show `cache N%` in the TUI usage widget

## 4. Provider error recovery

- [x] 4.1 Test and implement retry with backoff and the `provider_retry` event
- [x] 4.2 Test and implement "no retry after a tool call started"
- [x] 4.3 Test and implement overflow compaction and resend
- [x] 4.4 Test and implement the fallback model override and `model_fallback` event
- [x] 4.5 Wire `fallbackModel` config through the CLI factory

## 5. Output cutoff

- [x] 5.1 Test and implement the continuation note (maximum 2 per run)
- [x] 5.2 Add the `output_limit` terminal reason to events, subagent types, CLI exit codes, and the TUI

## 6. Wrap-up

- [x] 6.1 Show `provider_retry` and `model_fallback` in the TUI scrollback
- [x] 6.2 Update `README.md`, `docs/COMPACTION.md`, and `PROVIDERS.md`
- [ ] 6.3 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`
