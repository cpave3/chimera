## 1. Shared controller

- [x] 1.1 Move the App's JSX into `InlineView` and shared `Dialogs`; move dialog handlers into the controller
- [x] 1.2 Route screen clears through one controller function

## 2. Theme

- [x] 2.1 Test and add `surface` tokens and `text.dim`
- [x] 2.2 Test and add the fullscreen default palette, chosen by layout

## 3. Transcript style

- [x] 3.1 Test and implement `●` tool lines, `◆` assistant marker
- [x] 3.2 Test and implement grouped tool lines and the diff border

## 4. Fullscreen layout

- [x] 4.1 Test and implement the layout shell, prompt box and hints row
- [x] 4.2 Test and implement transcript scrolling (keys, follow, pin)
- [x] 4.3 Test and implement the entry cache and the mounted window
- [x] 4.4 Test and implement mouse wheel reports in the stdin filter and key handler

## 5. Context panel

- [x] 5.1 Test and implement session facts, context bar, plan and totals
- [x] 5.2 Test and implement the working tree reader and section
- [x] 5.3 Test and implement the status endpoint, client method and peers section
- [x] 5.4 Test and implement Ctrl+B and the narrow-terminal rule

## 6. Mount and CLI

- [x] 6.1 Mount on the alternate screen; restore after editor, pager and suspend
- [x] 6.2 Test and add `--inline`, `tui.layout`, `tui.mouse` and the TTY fallback
- [x] 6.3 Print the exit summary

## 7. Wrap-up

- [x] 7.1 Update `README.md`, `docs/` and the help panel
- [x] 7.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`
