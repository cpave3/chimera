## Context

`Agent.runInternal` (`packages/core/src/agent.ts`) runs one `streamText` call per step with `stopWhen: stepCountIs(1)`. The AI SDK executes tools inside the stream, so the `for await` over `fullStream` does not finish until every tool of the step has returned. The step timer is armed before `streamText` and cleared after the loop, which makes it a wall-clock limit on model output plus tool execution. A reproduction with a 400 ms tool and a 200 ms timeout ended with `run_finished(timeout)`.

The system prompt is rebuilt on each step by `Agent.composeSystemPrompt`, which appends the task list, the plan-accepted note, and the vision note. No provider call carries cache markers.

A stream `error` part or a thrown error sets `terminalReason = 'error'`. `finishReason === 'length'` maps to `max_steps`.

## Goals / Non-Goals

**Goals:**

- Long tool calls never trip the response timeout; a silent model still does.
- The cacheable prefix (tools, system prompt, earlier messages) is stable, and Anthropic-shape providers mark it.
- Temporary provider failures, context overflows, and output cutoffs recover without user action.

**Non-Goals:**

- Cache markers for OpenAI-shape providers. Their caching is automatic on a stable prefix.
- Retrying a step after a tool call started.
- Changing compaction thresholds or the recall store.

## Decisions

### Idle timer driven by stream parts

The run loop keeps a count of tool calls in flight. A `tool-call` part increments it; `tool-result` and `tool-error` decrement it. Every stream part clears the timer and arms it again only when the count is zero. The timer therefore measures the gap between model outputs and nothing else. Alternative considered: a separate tool timeout. Rejected, because tools already have their own limits (`timeout_ms` on bash, explicit `timeout_ms` on `spawn_agent`).

### Volatile state leaves the system prompt

The task list is removed from the system prompt. The latest `task_list` call carries the full list (replace-whole-list semantics) and stays in the conversation. When phase 2 of compaction summarizes a region and the kept tail has no `task_list` call, the compactor appends an authoritative `<tasks>` block to the summary, next to `<files>` and `<archived>`. When the tail still has a `task_list` call the block is omitted, so an older call later in the conversation cannot contradict a newer block before it.

The plan-accepted note and the vision note stay in the system prompt as one-shot additions. Moving them into the stored user message would change the text that rewind uses as the checkpoint key (`(userMessage, occurrence)`), which would break workspace restore. Their cache cost is small: the plan-accepted note follows a mode change, which already changes the prompt, and the vision note is sent only to the vision model.

### Cache markers in the provider middleware

The Anthropic branch of `createProvider` already wraps the model with a `transformParams` middleware. That middleware adds `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }` to the last system message and to the last message of the prompt. The system marker also covers the tool definitions, because the provider orders the prefix as tools, system, messages. This keeps `packages/core` provider-agnostic and covers compaction calls as well. Alternative considered: set the options in `Agent`. Rejected, because the agent would need to know the provider shape.

`ProviderSpec.promptCaching` (default `true`) turns the markers off for proxies that reject them.

### Recovery in the step loop

`streamText` runs with `maxRetries: 0`; the agent owns the retry policy so that mid-stream failures and request failures follow one rule. A failed step is classified:

| Class | Detection | Action |
| --- | --- | --- |
| Overflow | status 400 or 413, or a message that names the context or prompt length | Force one summarizing compaction, resend the step. One attempt per step. |
| Temporary | `APICallError.isRetryable`, status 408, 409, 429, 5xx, a network error, or an `overloaded` or `rate_limit` stream error | Wait, then resend the step. Maximum 4 retries per step. |
| Other | everything else | End the run with `error`, as today. |

Both actions apply only when no tool call started in the failed step. The wait is `min(60 s, retry-after)` when the provider sends `retry-after` or `retry-after-ms`, else 1 s, 2 s, 4 s, 8 s. The wait ends early on interrupt. Each wait emits `provider_retry { attempt, maxAttempts, delayMs, error }`.

When retries are exhausted and a fallback model resolver is registered, the agent installs a run-scoped model override (the same slot the vision route uses), emits `model_fallback { from, to, error }`, and resends the step. The override is cleared when the run ends. One fallback per run.

### Output cutoff

When a terminal step ends with `finishReason === 'length'`, the agent appends a user-role continuation note and loops, at most 2 times per run. After that the run ends with the reason `output_limit`. `chimera run` maps `output_limit` to exit code 2, the code that `max_steps` uses.

## Risks / Trade-offs

- [The model loses sight of the task list between compactions] → The latest `task_list` call stays in the conversation, and the `<tasks>` block covers the summarized case.
- [A proxy rejects `cache_control`] → `promptCaching: false` on that provider.
- [A retried step shows partial text twice] → Existing replay handling finalizes the partial block and emits the new text under a synthetic id; most temporary errors arrive before any text.
- [Overflow detection misses a provider's wording] → The run ends with `error` as it does today; the patterns are in one function and are easy to extend.
- [`output_limit` is a new terminal reason] → Additive for the event stream; documented; the exit code is unchanged.
