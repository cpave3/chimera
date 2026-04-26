## Context

Chimera agents currently have no structured way to ask the user for clarification. They can only emit assistant text and hope the user responds, or make assumptions. The codebase already has a close analogue—the **permission request flow** in `packages/permissions` and `packages/core/src/agent.ts`—which pauses the agent, emits an event over SSE, and resumes when the client calls back with a resolution. The question tool mirrors that pattern.

Relevant existing infrastructure:

- **Tool definitions** use `defineTool()` from `packages/tools/src/define.ts`, which takes a Zod input schema, an `execute` function, and an optional `formatScrollback` for TUI rendering.
- **`AgentEvent`** is a discriminated union in `packages/core/src/events.ts`. The server publishes events via an in-memory ring buffer (`packages/server/src/event-bus.ts`, capacity 1000) and exposes them as SSE on `/v1/sessions/:id/events`.
- **`Session.status`** in `packages/core/src/types.ts` already includes `waiting_for_input` and `waiting_for_permission`.
- **`ChimeraClient`** in `packages/client/src/client.ts` exposes events via `async *subscribe()` (an async iterator), not an EventEmitter. Consumers iterate the stream and call methods like `resolvePermission(requestId, decision)` imperatively.
- **Request IDs** use `newRequestId()` from `@chimera/core`, shared with the permission flow.
- **TUI scrollback** renders tool calls inline via `ToolBody.tsx`, which switches on `entry.toolName` and returns a body component.

## Goals / Non-Goals

**Goals:**

- Enable agents to ask structured questions with predefined options
- Support single-select (radio) and multi-select (checkbox) question types
- Allow per-question free-text input when needed
- Provide keyboard navigation (arrows, tab, space, enter, escape) in the TUI
- Support multi-question forms with back navigation
- Expose questions via the existing SDK iterator surface
- Teach the agent (via system prompt) when to use the tool

**Non-Goals:**

- Rich text / markdown formatting in questions (plain text only)
- Non-terminal UIs (web, mobile)
- Conditional question logic / branching (handled by the agent re-asking)
- Voice or other input modalities
- Screen-reader / a11y guarantees beyond what Ink natively provides
- Persisting pending questions across server restarts (in-memory only, like other events)

## Decisions

### Decision: Event-based question flow, mirroring the permission pattern

**Choice:** The agent calls a new `agent.raiseQuestionRequest(req)` method (analogous to `raisePermissionRequest`). It emits a `question_request` event, sets session status to `waiting_for_input`, and suspends the tool's promise. The client calls `client.answerQuestion(requestId, answers)`, which routes to `agent.resolveQuestion()`, emits `question_resolved`, and resumes the tool.

**Rationale:** Reuses the proven permission pause/resume machinery. No new transport. Event ordering and cancellation behavior are already understood for this shape.

**Alternatives considered:**
- Tool-result polling: requires blocking tool calls for minutes; awkward.
- WebSocket: SSE works fine for this latency.

### Decision: Reuse `waiting_for_input` status, not a new status

**Choice:** When a question is pending, `Session.status` is `waiting_for_input`. No new enum value.

**Rationale:** The status enum already distinguishes "waiting on the human" (`waiting_for_input`) from "waiting on the human's permission decision" (`waiting_for_permission`). A question is plainly user input. Adding `waiting_for_question` would proliferate states without behavioral payoff—UI consumers can read the active `question_request` event to know what kind of input is expected.

### Decision: SDK uses async iterator + `answerQuestion()`, not a callback handler

**Choice:** The `question_request` event flows through the existing `client.subscribe()` async iterator. Consumers detect the event and call `client.answerQuestion(requestId, answers)` to respond. No `onQuestion` callback.

**Rationale:** Consistency with the permission pattern (`client.resolvePermission`). `ChimeraClient` is not an EventEmitter; introducing a callback surface only for this feature would split the SDK's interaction model.

**Alternatives considered:**
- `onQuestion` async callback: convenient for some consumers, but inconsistent and would require a parallel API. Consumers wanting callback-style can wrap the iterator themselves.

### Decision: Single tool with a `questions` array

**Choice:** One `ask_question` tool taking `questions: Question[]`. Each `Question` has `id`, `prompt`, `type: 'single' | 'multi'`, `options: QuestionOption[]`, and optional `allowFreeText: boolean`. Single-question calls pass an array of length 1.

**Rationale:** Simpler API surface than separate single/multi tools; matches "form vs. wizard" UX naturally.

**Alternatives considered:**
- Separate `ask_single`/`ask_multi` tools: more discoverable but duplicates schema and TUI code.
- Sequential individual calls: more round-trips and worse UX for related questions.

### Decision: Option schema is `{ value, label, description? }`

**Choice:** `value` is the machine identifier returned to the agent, `label` is shown to the user, `description` is optional secondary text.

**Rationale:** Lets the agent receive stable identifiers regardless of presentation tweaks; description is needed for non-trivial technical choices.

### Decision: Free-text is per-question and exclusive of selected options

**Choice:** When `allowFreeText: true`, the UI exposes an "Other…" affordance. Selecting it opens a text input. If the user submits free text, the response for that question is `["__free_text__:<their text>"]` and any prior option selections for that question are discarded. Free text is exclusive even in multi-select.

**Rationale:** Mixing free text with structured options creates ambiguous responses for the agent (is "Other" a category alongside the picks, or a replacement?). Exclusive free text is unambiguous and easier to teach in the system prompt.

### Decision: Tool returns a JSON-serialized response to the model

**Choice:** The tool's string output to the model is `JSON.stringify({ answers: string[][], cancelled?: boolean, timedOut?: boolean })`. The outer array is per-question (in the order the questions were asked). Each inner array is the selected `value`s (or a single `__free_text__:…` entry).

**Rationale:** Structured output is parseable by the agent and trivially serializable. Cancellation and timeout are normal results, not exceptions, so the agent can react gracefully (e.g., "I see you cancelled — would you like a different approach?") without the tool call appearing as an error.

### Decision: Cancellation and timeout are non-error tool results

**Choice:** User pressing Escape (TUI) or the SDK calling `client.cancelQuestion(requestId)` resolves the tool with `{ answers: [], cancelled: true }`. A 5-minute timeout (configurable) resolves with `{ answers: [], timedOut: true }`. Agent abort (`AbortSignal`) rejects the pending tool promise the same way the permission flow does, and clears the pending question.

**Rationale:** Cancellation is a legitimate user response, not a programmer error; surfacing it as a tool result keeps the conversation coherent. Abort follows the existing tool-cancellation contract.

### Decision: `ask_question` is auto-approved by the permission gate

**Choice:** Register `ask_question` with permission mode `auto-approve` (no user confirmation needed before the tool runs).

**Rationale:** Asking a question is itself a user-facing UI action; gating it behind another approval prompt would be absurd. The "approval" is the user answering the question.

### Decision: Concurrent `ask_question` calls are rejected

**Choice:** If the agent (or a subagent) calls `ask_question` while another question from the same session is pending, the second call rejects immediately with a tool error: `"A question is already pending in this session"`.

**Rationale:** Two simultaneous modal questions would race for the same UI surface and confuse both the user and the agent. The agent can re-ask after the first resolves. (Subagents inherit the parent session's gate.)

### Decision: TUI renders questions as a modal overlay, not as scrollback

**Choice:** A `<QuestionModal>` Ink component renders above the scrollback while a question is pending. Scrollback shows a brief "Waiting on user input…" entry for the tool call; the modal is the interactive surface. After resolution, the modal closes and the scrollback entry updates with a compact summary of the answer (rendered via `formatScrollback`).

**Rationale:** Inline-only rendering would force the user to scroll to the active question and would break if subsequent output appeared after the tool call. A modal is also closer to the form-style UX the user described. The scrollback summary preserves history.

### Decision: Multi-question form navigation

**Choice:** ↑/↓ moves option focus within the current question. Tab / Shift+Tab moves between questions. Space toggles option selection (and is the only way to select in multi-select). Enter submits the entire form (only valid when every required question has at least one selection or free-text answer). Escape cancels the whole form.

**Rationale:** Standard form interaction; Space-to-toggle prevents Enter-fat-finger accidents; whole-form submit matches the design goal of related questions answered together.

### Decision: Question request IDs use `newRequestId()` from `@chimera/core`

**Choice:** Reuse the same ID generator as permission requests.

**Rationale:** Consistency; one request ID format across the system. No reason to invent a parallel scheme.

### Decision: Partial form state is client-local

**Choice:** While the user navigates a multi-question form, partial answers stay on the client. The server is only notified on submit, cancel, or timeout. No `question_progress` events.

**Rationale:** Avoids chatty event traffic and keeps the server stateless about UI navigation. Programmatic SDK consumers compute their answers locally and call `answerQuestion` once.

## Risks / Trade-offs

- **[Risk]** Agent overuses questions, interrupting flow. **Mitigation:** System prompt guidance ("prefer assumptions when low-stakes; ask only when wrong choice has real cost").
- **[Risk]** A question is asked while the SSE buffer rolls over (very long sessions, ~1000 events of churn). **Mitigation:** ring buffer is large enough for typical sessions; document that question events are not durable across long disconnects, same as all other events.
- **[Risk]** Multi-question UI becomes cluttered for large forms. **Mitigation:** soft limit of 5 questions per call documented in the system prompt; UI scrolls if exceeded.
- **[Risk]** SDK consumers ignore `question_request` events and the agent hangs until timeout. **Mitigation:** clear documentation; the 5-minute timeout bounds the worst case.
- **[Trade-off]** Modal blocks the main input. Acceptable: the design is explicitly turn-based.
- **[Trade-off]** Free-text is exclusive of selected options. Some users may want both; if needed later, add a second free-text-supplement field rather than overloading the existing one.

## Migration Plan

No migration. New additive capability. System prompt updates take effect on the next session.

## Open Questions

None.
