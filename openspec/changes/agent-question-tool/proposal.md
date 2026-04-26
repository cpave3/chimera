## Why

Agents often need user clarification to proceed effectively—whether choosing between implementation approaches, confirming assumptions, or gathering missing context. Currently, agents must either make assumptions (risking incorrect outcomes) or ask open-ended text questions that are slow to answer. A structured question tool with predefined options enables more efficient, precise user interactions while supporting both interactive TUI and programmatic SDK consumers.

## What Changes

- **New `ask_question` tool** for agents to present structured questions to users
- Support for **single-select (radio)** and **multi-select (checkbox)** question types
- **Suggested options** with labels and optional descriptions for each choice
- **Free-text input** option (per question) when constrained answers are not enough
- **TUI modal component** with keyboard navigation (arrows, tab, enter, space, escape)
- **Multi-question forms** with back navigation and answer modification before submit
- **SDK support** via the existing async-iterator event stream on `@chimera/client`, with a new `client.answerQuestion(requestId, answers)` method (mirroring `client.resolvePermission`)
- **System prompt updates** teaching agents when and how to use the question tool

## Capabilities

### New Capabilities

- `agent-question-tool`: Tool definition and agent-facing behavior for asking structured questions
- `interactive-question-ui`: TUI modal for rendering questions with keyboard navigation
- `question-flow-state`: State management for multi-question forms with back navigation, cancellation, and timeout
- `question-tool-sdk`: Event-stream and method exposure on `@chimera/client` for programmatic consumers

### Modified Capabilities

- `system-prompt`: Add guidance on question-tool usage patterns

## Impact

- **Packages affected**: `packages/tools` (tool definition), `packages/core` (event types, agent pause/resume), `packages/server` (event publishing, response endpoint), `packages/client` (event surface, `answerQuestion` method), `packages/tui` (modal component, scrollback rendering), `packages/cli` (system-prompt assembly)
- **Breaking changes**: None—new capability, additive
- **Dependencies**: New `AgentEvent` variants (`question_request`, `question_resolved`); reuses existing `newRequestId()` from `@chimera/core`
- **Persistence**: Question events live in the in-memory event-bus ring buffer (1000 events) like all other agent events; no new storage layer
