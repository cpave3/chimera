## ADDED Requirements

### Requirement: Session lifecycle and state

The `@chimera/core` package SHALL expose a `Session` object carrying, at minimum: a ULID `id`, `cwd`, `createdAt`, the full conversation as AI-SDK `CoreMessage[]`, an ordered list of `ToolCallRecord`s, a `status` field in `{"idle","running","waiting_for_input","waiting_for_permission","error"}`, a `ModelConfig`, and a `sandboxMode` value.

In MVP, `sandboxMode` SHALL be the literal `"off"` but the field MUST exist on the type so that persisted sessions from MVP remain readable after later changes extend `SandboxMode`.

#### Scenario: Session created through Agent constructor

- **WHEN** the consumer calls `new Agent(opts)` with `opts.cwd`, `opts.model`, `opts.modelClient`, `opts.executor`, and `opts.sandboxMode`
- **THEN** `agent.session` SHALL be populated with a fresh ULID `id`, `cwd = opts.cwd`, `status = "idle"`, empty `messages` / `toolCalls`, and `createdAt` set to the current Unix milliseconds

#### Scenario: Session resumed from persisted state

- **WHEN** the consumer constructs an `Agent` with `opts.sessionId` matching a previously persisted session file under `~/.chimera/sessions/<sessionId>.json`
- **THEN** `agent.session` SHALL deserialize that file's contents and `status` SHALL be reset to `"idle"` regardless of the persisted value

### Requirement: Agent run loop

The `Agent.run(userMessage)` method SHALL return an `AsyncIterable<AgentEvent>` and internally SHALL drive the Vercel AI SDK `streamText` helper with the session's message history, the configured model, the configured tools, and `stopWhen: stepCountIs(maxSteps)` where `maxSteps` comes from `ModelConfig` and defaults to `100`.

The loop SHALL translate `fullStream` parts to `AgentEvent`s as follows: `text-delta` → `assistant_text_delta`; `text` (accumulated) → `assistant_text_done`; `tool-call` → `tool_call_start` with the resolved `target`; `tool-result` → `tool_call_result`; `tool-error` → `tool_call_error`; `finish-step` → `step_finished`; `finish` ends the stream.

The final event emitted SHALL be `run_finished` with a `reason` in `{"stop","max_steps","error","interrupted"}` and an optional `error` string.

#### Scenario: Single-turn run with no tool calls

- **WHEN** the consumer iterates `agent.run("hello")` against a model that returns plain text and finishes
- **THEN** the event sequence SHALL include `user_message`, one or more `assistant_text_delta`, exactly one `assistant_text_done`, exactly one `step_finished`, and exactly one terminal `run_finished` with `reason: "stop"`

#### Scenario: Run that reaches max steps

- **WHEN** a model repeatedly emits tool calls without ever finishing within `maxSteps` steps
- **THEN** the loop SHALL terminate and emit `run_finished` with `reason: "max_steps"` and the session SHALL be persisted with `status: "idle"` (not `"error"`)

### Requirement: Interrupt

`Agent.interrupt()` SHALL cause any in-flight `run()` iteration to abort. Internally it SHALL signal an `AbortController` that is threaded into `streamText` and into the `Executor` for any in-flight tool calls.

#### Scenario: Interrupt while a bash tool is executing

- **WHEN** a consumer calls `agent.interrupt()` while a bash tool call is mid-execution
- **THEN** the tool's child process SHALL receive SIGTERM (via `child_process.spawn({ signal })`), the `run()` iterator SHALL yield `tool_call_error` for the interrupted call, and the final `run_finished` event SHALL have `reason: "interrupted"`

### Requirement: Permission pause and resume

When a tool call is dispatched through an `Executor` that raises a permission request, the `Agent` SHALL emit a `permission_request` event carrying a fresh `requestId`, set `session.status` to `"waiting_for_permission"`, and suspend the loop until `Agent.resolvePermission(requestId, decision, remember?)` is called.

`resolvePermission` SHALL release the pause latch and cause the tool to either execute (on `"allow"`) or return `{ error: "denied by user" }` as its result (on `"deny"`) so that the model can observe the denial.

If `remember` is provided, the gate SHALL persist the matching rule in the requested scope before resuming the tool.

#### Scenario: Allow-once resolves one pending request

- **WHEN** a consumer receives a `permission_request` event and calls `agent.resolvePermission(requestId, "allow")` without a `remember` argument
- **THEN** the tool SHALL execute, a `permission_resolved` event SHALL fire with `decision: "allow"` and `remembered: false`, the session `status` SHALL return to `"running"`, and no rule SHALL be persisted

#### Scenario: Denial is visible to the model

- **WHEN** the consumer calls `agent.resolvePermission(requestId, "deny")`
- **THEN** the corresponding `tool_call_result` event SHALL carry a payload of `{ error: "denied by user" }` and the subsequent model step SHALL receive that payload as the tool's result

### Requirement: Session persistence

On every `step_finished`, `@chimera/core` SHALL serialize the current `Session` as JSON to `~/.chimera/sessions/<sessionId>.json`, overwriting any existing content.

#### Scenario: Persisted snapshot reflects latest completed step

- **WHEN** an agent completes step N of a multi-step run
- **THEN** the on-disk session file SHALL contain all messages and tool calls up to and including step N before step N+1 begins

### Requirement: System prompt composition

`@chimera/core` SHALL compose the system prompt from: (a) a fixed ~300–500-word role prompt covering tool usage, brevity, and the `target` parameter; (b) any `AGENTS.md` contents discovered by walking from `cwd` up to the nearest git root (or `$HOME` if none), concatenated with closer files last (higher priority).

The composition SHALL expose an extension point (a pure function) so that later changes introducing skills can append a skill index without modifying `@chimera/core` internals.

#### Scenario: AGENTS.md discovered in a git repo

- **WHEN** the session `cwd` is inside a git repository that contains `AGENTS.md` at its root and another `AGENTS.md` in a subdirectory equal to `cwd`
- **THEN** the composed system prompt SHALL contain both files' contents with the subdirectory file appearing after (i.e., overriding) the repo-root file

### Requirement: AgentEvent stream is the sole observable surface

Every state change that a consumer needs to observe (assistant text, tool calls, permission requests, step boundaries, run completion) SHALL be reported as an `AgentEvent` value from the `run()` iterator. `@chimera/core` SHALL NOT expose a second channel (callbacks, direct `Session` mutation observation, hooks) for the same state changes.

#### Scenario: A consumer reconstructs UI solely from events

- **WHEN** a consumer records every event yielded from `run()` and replays them into an empty UI state machine
- **THEN** the reconstructed UI SHALL be byte-equal to one that had observed the run live, including tool calls, permission prompts, and final assistant text
