## 1. Core and tool

- [x] 1.1 Test and implement question types, the two events and the agent's pending questions (ask, resolve, interrupt cancels)
- [x] 1.2 Test and implement the `ask_question` tool (limits, answers, cancel, no user)

## 2. Server and client

- [x] 2.1 Test and implement `pendingQuestions` in the snapshot and the answer endpoint
- [x] 2.2 Add `answerQuestion` to the client

## 3. TUI

- [x] 3.1 Test and implement the question dialog (arrows, digits, own answer, several questions, dismiss)
- [x] 3.2 Wire it into the App: events, snapshot on attach, activity text

## 4. Wiring and wrap-up

- [x] 4.1 Register the tool in the factory; the interactive command turns its user on
- [x] 4.2 Update `README.md` and `docs/request-user-input.md`
- [x] 4.3 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`
