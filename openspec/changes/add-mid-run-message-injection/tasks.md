## 1. Core agent

- [x] 1.1 Add `pendingInjectMessages` buffer and `injectRunMessage(content, images?)` method to `Agent`.
- [x] 1.2 Clear `pendingInjectMessages` at the start of `runInternal` (next to `pendingImageMessages = []`).
- [x] 1.3 Drain `pendingInjectMessages` at the step boundary after the `terminalReason !== 'stop'` break: push user messages, emit `user_message` events, persist `message_appended`, install a fresh `AbortController`.
- [x] 1.4 On a terminal (stop) step with injections, increment `terminalStepCount` and `continue` the outer loop so the model responds.
- [x] 1.5 Ensure interrupted/errored steps drop pending injects (drain is after the break).

## 2. Server registry

- [x] 2.1 In `AgentRegistry.injectMessage`, add a mid-run branch: when `runActive` is true (and no compaction/inject/rewind), call `agent.injectRunMessage` and return `'injected'` without `snapshotWorkspace` or `bus.publish`.
- [x] 2.2 Keep the `already-running` return for compaction/inject/rewind-active cases.
- [x] 2.3 Leave the idle path (appendMessage + snapshot + publish) unchanged.

## 3. TUI

- [x] 3.1 Add `injectMidRun(text)` helper: calls `client.appendMessage`, surfaces "injected: ..." info, catches errors.
- [x] 3.2 In `handleSubmit`, route regular messages to `injectMidRun` when `running`; queue when `busy && !running`; send when idle.
- [x] 3.3 Update user-command and skill `default:` branches to `injectMidRun` when `running`.

## 4. Tests

- [x] 4.1 `agent.test.ts`: mid-run injection drained at the next step boundary (tool-call step 1 → step 2 sees the correction + `user_message` event).
- [x] 4.2 `agent.test.ts`: pending injects dropped when the run is interrupted.
- [x] 4.3 `agent-registry.test.ts`: `injectMessage` returns `'injected'` during an active run and a `user_message` event is published after the step boundary.
- [x] 4.4 `agent-registry.test.ts`: `injectMessage` returns `'already-running'` when a compaction is active.
- [x] 4.5 `app.test.tsx`: a regular message typed while running calls `appendMessage` and shows "injected:" (not "queued").
- [x] 4.6 `app.test.tsx`: a `!` command typed while busy still queues; the queue drains after the run ends.

## 5. OpenSpec

- [x] 5.1 Create `openspec/changes/add-mid-run-message-injection/` with proposal, design, specs, and tasks.
