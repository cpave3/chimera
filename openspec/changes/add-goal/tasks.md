## 1. Goal rules

- [ ] 1.1 Test and implement the check prompt, the answer parser and the message to the agent

## 2. Agent

- [ ] 2.1 Test and implement `setGoal`, persistence and the `goal_updated` event
- [ ] 2.2 Test and implement the check at a clean stop: met, not met, impossible, unchecked, no goal
- [ ] 2.3 Test and implement the continuation limit and the order with the Stop hook

## 3. Server and client

- [ ] 3.1 Test and implement `PUT /v1/sessions/:id/goal` and `client.setGoal`

## 4. CLI

- [ ] 4.1 Test and add `goal.maxContinuations`; supply the checker's model call in the factory
- [ ] 4.2 Test and implement `chimera run --goal` and its exit codes

## 5. TUI

- [ ] 5.1 Test and implement `/goal`, `/goal clear`, `/goal`
- [ ] 5.2 Test and implement the goal in the panel and the footer, and the transcript lines

## 6. Wrap-up

- [ ] 6.1 Update `README.md` and the command docs
- [ ] 6.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`, one run with a real model
