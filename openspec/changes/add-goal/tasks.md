## 1. Goal rules

- [x] 1.1 Test and implement the check prompt, the answer parser and the message to the agent

## 2. Agent

- [x] 2.1 Test and implement `setGoal`, persistence and the `goal_updated` event
- [x] 2.2 Test and implement the check at a clean stop: met, not met, impossible, unchecked, no goal
- [x] 2.3 Test and implement the continuation limit and the order with the Stop hook

## 3. Server and client

- [x] 3.1 Test and implement `PUT /v1/sessions/:id/goal` and `client.setGoal`

## 4. CLI

- [x] 4.1 Test and add `goal.maxContinuations`; supply the checker's model call in the factory
- [x] 4.2 Test and implement `chimera run --goal` and its exit codes

## 5. TUI

- [x] 5.1 Test and implement `/goal`, `/goal clear`, `/goal`
- [x] 5.2 Test and implement the goal in the panel and the footer, and the transcript lines
- [x] 5.3 Test and switch notices and errors of the transcript to word wrap (a long reason broke inside words)

## 6. Wrap-up

- [x] 6.1 Update `README.md` and the command docs
- [x] 6.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`, one run with a real model
