## ADDED Requirements

### Requirement: Idle response timeout
`responseTimeoutMs` SHALL measure only the time during which the model produces no stream output. The timer SHALL restart on every stream part and SHALL be suspended while at least one tool call of the current step is executing. A value of `0` SHALL disable the timeout.

#### Scenario: Tool runs longer than the timeout
- **WHEN** a step emits a tool call whose execution takes longer than `responseTimeoutMs`
- **THEN** the tool result is delivered to the model and the run does not end with `timeout`

#### Scenario: Model is silent
- **WHEN** the model produces no stream part for longer than `responseTimeoutMs` and no tool is executing
- **THEN** the run ends with `run_finished { reason: "timeout" }`

### Requirement: Stable system prompt
The system prompt sent to the model SHALL be identical on every step of a run and across runs of a session, except after a mode change, a reload of instruction files, or while a one-shot note (plan accepted, vision turn) applies. The task list SHALL NOT be part of the system prompt.

#### Scenario: Task list changes during a run
- **WHEN** the model updates the task list between two steps of one run
- **THEN** both steps send the same system prompt

### Requirement: Task list in compaction summaries
When compaction replaces messages with a summary and the kept messages contain no `task_list` call, the summary SHALL end with a `<tasks>` block that lists every task with its status.

#### Scenario: Last task_list call is summarized
- **WHEN** the session has tasks and the summarized region contains the only `task_list` call
- **THEN** the summary message contains a `<tasks>` block with each task and status

#### Scenario: A task_list call is kept
- **WHEN** the kept messages still contain a `task_list` call
- **THEN** the summary has no `<tasks>` block

### Requirement: Provider error recovery
When a step fails with a temporary provider error and no tool call started in that step, the agent SHALL wait and send the step again, at most 4 times per step, and SHALL emit `provider_retry` before each wait. The wait SHALL honor `retry-after` up to 60 seconds and otherwise double from 1 second. When a tool call started in the failed step, the agent SHALL NOT retry.

#### Scenario: Temporary error before any output
- **WHEN** the provider fails a step with HTTP 429 and the next attempt succeeds
- **THEN** the agent emits one `provider_retry` event and the run ends with `stop`

#### Scenario: Error after a tool call started
- **WHEN** the stream fails after a tool call of that step started
- **THEN** the run ends with `error` and the tool is not executed a second time

#### Scenario: Retries exhausted
- **WHEN** five consecutive attempts of one step fail with a temporary error and no fallback model is configured
- **THEN** the run ends with `error`

### Requirement: Context overflow recovery
When the provider rejects a step because the prompt exceeds the context window, and no tool call started in that step, the agent SHALL run one summarizing compaction and send the step again. It SHALL do this at most once per step.

#### Scenario: Overflow on a long session
- **WHEN** the provider answers a step with a context-length error and a compactor is configured
- **THEN** the agent emits `compaction_started` and `compaction_finished`, resends the step, and the run continues

### Requirement: Output cutoff continuation
When a step without tool calls ends because the output limit was reached, the agent SHALL ask the model to continue, at most 2 times per run. After that the run SHALL end with `run_finished { reason: "output_limit" }`.

#### Scenario: One cutoff
- **WHEN** a step ends with finish reason `length` and the next step ends with `stop`
- **THEN** the run ends with `stop` and the conversation contains one continuation note

#### Scenario: Repeated cutoffs
- **WHEN** three consecutive steps end with finish reason `length`
- **THEN** the run ends with `output_limit`

### Requirement: Fallback model
When a fallback model is configured and a step exhausts its retries, the agent SHALL emit `model_fallback` and run the remaining steps of that run on the fallback model. The session model SHALL be restored when the run ends.

#### Scenario: Primary model stays unavailable
- **WHEN** every attempt on the primary model fails with a temporary error and a fallback model is configured
- **THEN** the agent emits `model_fallback`, the step succeeds on the fallback model, and the next run uses the primary model again
