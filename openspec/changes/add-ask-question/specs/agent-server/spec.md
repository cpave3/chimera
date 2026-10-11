## ADDED Requirements

### Requirement: Pending questions
While a question waits for its answer, the session snapshot (`GET /v1/sessions/:id`) SHALL list it under `pendingQuestions`, so that a client that connects after the question was asked can show it. The server SHALL accept `POST /v1/sessions/:id/questions/:requestId` with either the answers or a cancellation, SHALL settle the waiting tool call, and SHALL answer 409 for a question that is not pending.

#### Scenario: Client connects again
- **WHEN** a question is pending and a client requests the session
- **THEN** the response has the question under `pendingQuestions`

#### Scenario: Answer
- **WHEN** a client posts answers for a pending question
- **THEN** the response status is 204, the tool call returns those answers, and the question is no longer pending

#### Scenario: Answered twice
- **WHEN** a client posts an answer for a question that was answered already
- **THEN** the response status is 409
