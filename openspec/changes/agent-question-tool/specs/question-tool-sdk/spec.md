## ADDED Requirements

### Requirement: Question events flow through the existing `subscribe()` iterator

`ChimeraClient` SHALL emit `question_request` and `question_resolved` events through its existing `async *subscribe()` iterator. No new EventEmitter surface and no `onQuestion` callback SHALL be added.

#### Scenario: SDK consumer receives a question event

- **WHEN** the agent calls `ask_question`
- **AND** an SDK consumer is iterating `client.subscribe()`
- **THEN** the iterator SHALL yield a `question_request` event containing `requestId`, `questions`, and `timestamp`

#### Scenario: SDK consumer receives the resolution event

- **WHEN** a pending question is resolved (answered, cancelled, or timed out)
- **THEN** the iterator SHALL yield a `question_resolved` event containing `requestId` and the same `{ answers, cancelled?, timedOut? }` payload the agent received

### Requirement: SDK exposes `answerQuestion` and `cancelQuestion`

`ChimeraClient` SHALL expose `answerQuestion(requestId: string, answers: string[][]): Promise<void>` and `cancelQuestion(requestId: string): Promise<void>` methods. These SHALL POST to the corresponding server routes.

#### Scenario: Programmatic consumer answers a question

- **WHEN** a `question_request` event is received with `requestId` `"q-123"` and one single-select question
- **AND** the consumer calls `client.answerQuestion("q-123", [["option-a"]])`
- **THEN** the server SHALL resolve the pending question
- **AND** the agent SHALL receive `'{"answers":[["option-a"]]}'` as the tool result

#### Scenario: Programmatic consumer cancels a question

- **WHEN** a `question_request` event is received
- **AND** the consumer calls `client.cancelQuestion(requestId)`
- **THEN** the server SHALL emit `question_resolved` with `cancelled: true`
- **AND** the agent SHALL receive `'{"answers":[],"cancelled":true}'`

### Requirement: SDK does not require a registered handler

A `question_request` event being yielded by the iterator without any consumer-side action SHALL NOT throw. The pending question SHALL remain pending until answered, cancelled, timed out, or aborted.

#### Scenario: No consumer action does not throw

- **WHEN** a `question_request` event is yielded by `client.subscribe()`
- **AND** no consumer calls `answerQuestion` or `cancelQuestion`
- **THEN** the SDK SHALL NOT throw
- **AND** the pending question SHALL eventually resolve via timeout

### Requirement: Question types are exported from `@chimera/client`

The `@chimera/client` package SHALL export TypeScript types `Question`, `QuestionOption`, `QuestionRequest`, and `QuestionResponse`, matching the runtime payload shapes exactly.

#### Scenario: Type-safe consumer code

- **WHEN** an SDK consumer imports `QuestionRequest` from `@chimera/client`
- **THEN** the type SHALL match the runtime `question_request` event payload
- **AND** TypeScript SHALL flag mismatches at compile time

### Requirement: Multi-question groups are delivered in a single event

When the agent calls `ask_question` with N questions, the SDK SHALL emit one `question_request` event whose `questions` array contains all N questions. The corresponding answer SHALL be submitted as a single `answerQuestion` call.

#### Scenario: Three-question event and submission

- **WHEN** the agent calls `ask_question` with three questions
- **THEN** the SDK SHALL yield one `question_request` event with `questions.length === 3`
- **WHEN** the consumer calls `answerQuestion(requestId, [["a"], ["b","c"], ["__free_text__:foo"]])`
- **THEN** the agent SHALL receive `'{"answers":[["a"],["b","c"],["__free_text__:foo"]]}'`

### Requirement: Late subscribers receive in-flight question requests via event-bus replay

If a consumer subscribes to `client.subscribe()` while a question is already pending, the existing event-bus replay SHALL include the active `question_request` event so the consumer can still answer it.

#### Scenario: Reconnect mid-question

- **WHEN** a question is pending and the SSE connection drops
- **AND** a new subscription is opened with `sinceEventId` set to before the question event
- **THEN** the replay SHALL include the `question_request` event
- **AND** the consumer SHALL be able to call `answerQuestion(requestId, …)` and have it succeed
