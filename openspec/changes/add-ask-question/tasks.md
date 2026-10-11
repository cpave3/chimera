## 1. Core and tool

- [ ] 1.1 Test and implement question types, the two events and the agent's pending questions (ask, resolve, interrupt cancels)
- [ ] 1.2 Test and implement the `ask_question` tool (limits, answers, cancel, no user)

## 2. Server and client

- [ ] 2.1 Test and implement `pendingQuestions` in the snapshot and the answer endpoint
- [ ] 2.2 Add `answerQuestion` to the client

## 3. TUI

- [ ] 3.1 Test and implement the question dialog (arrows, digits, own answer, several questions, dismiss)
- [ ] 3.2 Wire it into the App: events, snapshot on attach, activity text

## 4. Wiring and wrap-up

- [ ] 4.1 Register the tool in the factory; the interactive command turns its user on
- [ ] 4.2 Update `README.md` and `docs/request-user-input.md`
- [ ] 4.3 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`
