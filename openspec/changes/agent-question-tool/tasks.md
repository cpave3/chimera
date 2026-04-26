## 1. Core Tool Definition (`packages/tools`)

- [ ] 1.1 Define `ask_question` via `defineTool()` in `packages/tools/src/ask-question.ts`
- [ ] 1.2 Zod schema: `{ questions: Question[] }` where `Question = { id: string, prompt: string, type: 'single' | 'multi', options: QuestionOption[], allowFreeText?: boolean }` and `QuestionOption = { value: string, label: string, description?: string }`
- [ ] 1.3 `execute()` calls `agent.raiseQuestionRequest(req)` (analogous to permission gate); returns `JSON.stringify({ answers, cancelled?, timedOut? })`
- [ ] 1.4 Implement `formatScrollback`: pre-resolve summary "Waiting on user input…"; post-resolve compact summary of answers (or "cancelled" / "timed out")
- [ ] 1.5 Register tool in CLI factory (`packages/cli/src/factory.ts`) with permission mode `auto-approve`
- [ ] 1.6 Export `Question`, `QuestionOption`, `QuestionRequest`, `QuestionResponse` types from `@chimera/tools`

## 2. Agent Core Integration (`packages/core`)

- [ ] 2.1 Add `question_request` and `question_resolved` variants to `AgentEvent` in `packages/core/src/events.ts`
- [ ] 2.2 Add `raiseQuestionRequest(req): Promise<QuestionResolution>` to `Agent` (mirrors `raisePermissionRequest`); store in `pendingQuestions: Map<requestId, { resolve, request }>`
- [ ] 2.3 Set `Session.status = 'waiting_for_input'` when a question is raised; restore to `'running'` on resolve (no new status enum value)
- [ ] 2.4 Add `resolveQuestion(requestId, answers)` and `cancelQuestion(requestId, reason: 'user' | 'timeout')` methods on `Agent`
- [ ] 2.5 Reject concurrent `raiseQuestionRequest` for the same session with `"A question is already pending in this session"`
- [ ] 2.6 Wire `AbortSignal` from the tool execute context: on abort, clear pending question and reject its promise (match permission abort behavior)
- [ ] 2.7 Implement timeout (default 5 min, override via tool input `timeoutMs?`) — on expiry, call `cancelQuestion(id, 'timeout')`
- [ ] 2.8 Reuse `newRequestId()` from `@chimera/core` for question request IDs

## 3. Server Wiring (`packages/server`)

- [ ] 3.1 Publish `question_request` and `question_resolved` events through the event bus (no schema changes — they ride on the existing `AgentEvent` envelope)
- [ ] 3.2 Add `POST /v1/sessions/:id/questions/:requestId/answer` route → `agent.resolveQuestion()`
- [ ] 3.3 Add `POST /v1/sessions/:id/questions/:requestId/cancel` route → `agent.cancelQuestion(id, 'user')`
- [ ] 3.4 Validate request bodies with Zod; reject answers for unknown / already-resolved request IDs

## 4. Question Flow State

- [ ] 4.1 Define `QuestionRequest` payload (server-emitted) and `QuestionResponse` payload (client-submitted) in `packages/core`
- [ ] 4.2 Server stores only the active pending question per session (Map keyed by requestId); cleared on resolve / cancel / timeout / abort
- [ ] 4.3 Confirm partial form state stays client-local — no `question_progress` events emitted

## 5. TUI Components (`packages/tui`)

- [ ] 5.1 `QuestionModal` Ink component, rendered as an overlay above scrollback when a `question_request` is active
- [ ] 5.2 `SingleSelectQuestion` (radio style) and `MultiSelectQuestion` (checkbox style) sub-components
- [ ] 5.3 `FreeTextInput` sub-component, shown only when "Other…" is the active selection for a question with `allowFreeText: true`
- [ ] 5.4 `QuestionForm` for multi-question groups: step indicator, Tab / Shift+Tab between questions, Enter to submit, Escape to cancel
- [ ] 5.5 Keyboard handling: ↑/↓ option focus; Space toggles selection; Enter submits the form; Escape cancels
- [ ] 5.6 Visual states: focused option (highlight), selected option (filled radio / checked box), unselected (empty marker), current question step indicator
- [ ] 5.7 Disable the main composer input while modal is active
- [ ] 5.8 Free-text exclusivity: selecting "Other…" clears any prior option picks for that question

## 6. TUI Integration

- [ ] 6.1 Subscribe to `question_request` events from `ChimeraClient.subscribe()`
- [ ] 6.2 Mount/unmount `QuestionModal` based on pending-question state
- [ ] 6.3 Call `client.answerQuestion(requestId, answers)` on submit, `client.cancelQuestion(requestId)` on Escape
- [ ] 6.4 Add a scrollback entry for the tool call: pending state ("Waiting on user input…") and resolved state (compact answer summary) via `formatScrollback`
- [ ] 6.5 Handle `question_resolved` to close the modal and re-enable the composer

## 7. SDK Support (`packages/client`)

- [ ] 7.1 `question_request` and `question_resolved` events flow through the existing `async *subscribe()` iterator (no new emitter)
- [ ] 7.2 Add `client.answerQuestion(requestId, answers: string[][])`: POSTs to the answer route
- [ ] 7.3 Add `client.cancelQuestion(requestId)`: POSTs to the cancel route
- [ ] 7.4 Export `QuestionRequest`, `QuestionResponse`, `Question`, `QuestionOption` types from `@chimera/client`
- [ ] 7.5 Document the iterator-based usage pattern (no `onQuestion` callback) in the client README

## 8. System Prompt Updates (`packages/cli` / system prompt assembly)

- [ ] 8.1 Locate the system-prompt file used by the CLI factory and add an "Asking Questions" section
- [ ] 8.2 Cover: when to ask vs. assume (lean toward assumptions for low-stakes choices)
- [ ] 8.3 Cover: single vs. multi-select selection guidance
- [ ] 8.4 Cover: prefer multi-question forms (≤5 questions) over sequential asks
- [ ] 8.5 Cover: how to handle `cancelled` and `timedOut` responses (treat as user signal, do not retry blindly)
- [ ] 8.6 Add 1–2 worked examples (e.g., "choose between two implementation approaches")

## 9. Testing

- [ ] 9.1 Unit: `ask_question` Zod schema accepts/rejects expected shapes
- [ ] 9.2 Unit: `Agent.raiseQuestionRequest` / `resolveQuestion` / `cancelQuestion` lifecycle (pending → resolved, pending → cancelled, pending → timed out, pending → aborted)
- [ ] 9.3 Unit: concurrent question request rejection
- [ ] 9.4 Unit: free-text exclusivity in single-select and multi-select
- [ ] 9.5 TUI: `SingleSelectQuestion`, `MultiSelectQuestion`, `QuestionForm` component tests with simulated keyboard input
- [ ] 9.6 TUI: keyboard navigation across multi-question forms (Tab, back-and-modify, Escape)
- [ ] 9.7 Integration: end-to-end question round-trip through server SSE → client iterator → `answerQuestion` → agent resume
- [ ] 9.8 Integration: timeout fires after configured duration; agent receives `timedOut: true`
- [ ] 9.9 Integration: agent abort mid-question clears pending state and rejects the tool promise
- [ ] 9.10 Integration: SDK iterator consumer answers a question without using the TUI
- [ ] 9.11 Integration: SSE reconnect mid-question — client receives the still-pending `question_request` from event-bus replay

## 10. Documentation

- [ ] 10.1 Add `ask_question` to the tools list in the project README
- [ ] 10.2 Document the SDK iterator pattern with a worked example (programmatic answerer)
- [ ] 10.3 Document TUI keyboard shortcuts for the question modal
