## 1. Shared controller

- [ ] 1.1 Move the App's JSX into `InlineView` and shared `Dialogs`; move dialog handlers into the controller
- [ ] 1.2 Route screen clears through one controller function

## 2. Theme

- [ ] 2.1 Test and add `surface` tokens and `text.dim`
- [ ] 2.2 Test and add the fullscreen default palette, chosen by layout

## 3. Transcript style

- [ ] 3.1 Test and implement `●` tool lines, `◆` assistant marker
- [ ] 3.2 Test and implement grouped tool lines and the diff border

## 4. Fullscreen layout

- [ ] 4.1 Test and implement the layout shell, prompt box and hints row
- [ ] 4.2 Test and implement transcript scrolling (keys, follow, pin)
- [ ] 4.3 Test and implement the entry cache and the mounted window
- [ ] 4.4 Test and implement mouse wheel reports in the stdin filter and key handler

## 5. Context panel

- [ ] 5.1 Test and implement session facts, context bar, plan and totals
- [ ] 5.2 Test and implement the working tree reader and section
- [ ] 5.3 Test and implement the status endpoint, client method and peers section
- [ ] 5.4 Test and implement Ctrl+B and the narrow-terminal rule

## 6. Mount and CLI

- [ ] 6.1 Mount on the alternate screen; restore after editor, pager and suspend
- [ ] 6.2 Test and add `--inline`, `tui.layout`, `tui.mouse` and the TTY fallback
- [ ] 6.3 Print the exit summary

## 7. Wrap-up

- [ ] 7.1 Update `README.md`, `docs/` and the help panel
- [ ] 7.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`
