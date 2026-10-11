## 1. Split App.tsx (no behavior change)

- [x] 1.1 Move entry rendering to `transcript.tsx` and prompt rendering to `prompt-view.tsx`
- [x] 1.2 Move the permission queue helpers to `permission-queue.ts`
- [x] 1.3 Move the status-bar widgets to `BottomChrome.tsx`
- [x] 1.4 Move session event handling to `session-events.ts`
- [x] 1.5 Move slash command dispatch to `slash-dispatch.ts`
- [x] 1.6 Move key handling to `key-handler.ts`
- [x] 1.7 Confirm the TUI tests pass with no assertion changed

## 2. Chrome

- [x] 2.1 Test and implement the single status row
- [x] 2.2 Test and implement the `?` help panel; remove the hints row

## 3. Activity line

- [x] 3.1 Test and implement the activity selector and line (tool, approval, compaction, retry, elapsed time)

## 4. Transcript

- [x] 4.1 Test and implement the markers for user messages and tool lines
- [x] 4.2 Test and implement grouped exploration calls in the scrollback store
- [x] 4.3 Test and implement the `Ctrl+T` transcript view

## 5. Task panel and live-region budget

- [x] 5.1 Test and implement the task panel
- [x] 5.2 Test and implement the live-region cap

## 6. Code colors

- [x] 6.1 Add the `syntax` theme tokens to the default theme and presets
- [x] 6.2 Test and implement highlighted code blocks

## 7. Approval list

- [x] 7.1 Test and implement the list with arrow, digit and letter keys

## 8. Wrap-up

- [x] 8.1 Update `README.md` and the theme example
- [x] 8.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`
