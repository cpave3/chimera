## 1. Tool result shape

- [x] 1.1 Add `startLine`, `contextBefore`, `contextAfter` to the edit tool's result type in `packages/tools/src/edit.ts` (or wherever `EditResult` lives) and to any exported type alias re-exported from the package barrel.
- [x] 1.2 In the edit tool implementation, after locating the unique `old_string` match, compute the 1-based `startLine` from the byte offset (count `\n` in the prefix + 1).
- [x] 1.3 Capture `contextBefore` as up to 3 lines from the **pre-edit** file immediately preceding `startLine` (top-of-file truncated).
- [x] 1.4 Compute `contextAfter` as up to 3 lines from the **post-edit** file immediately following the replaced span (end-of-file truncated). Strip trailing newlines from each captured line.
- [x] 1.5 For `replace_all: true`, set `startLine` from the **first** match and capture `contextBefore`/`contextAfter` around that first match.

## 2. Tool tests

- [x] 2.1 Update existing edit-tool tests that asserted `result == { replacements: 1 }` to also accept the new fields (or assert the full new shape).
- [x] 2.2 New test: unique match in the middle of a 20-line file → `startLine` correct, `contextBefore.length === 3`, `contextAfter.length === 3`.
- [x] 2.3 New test: match starting on line 1 → `contextBefore` is `[]`.
- [x] 2.4 New test: match ending on the final line → `contextAfter` is `[]`.
- [x] 2.5 New test: `replace_all: true` with three matches → `startLine` is the line of the first match.

## 3. Theme tokens

- [x] 3.1 Add `theme.status.errorBg` and `theme.status.successBg` to the theme type in `packages/tui/src/theme/types.ts`.
- [x] 3.2 Populate the new tokens in every built-in theme under `packages/tui/src/theme/` with a low-saturation tint of the corresponding fg color (dark themes: ~10–15% lightness; light themes: ~90% lightness).
- [x] 3.3 Update theme-loading/validation (if any) to treat the new tokens as optional, so user overlay themes without them keep working.

## 4. LCS helper

- [x] 4.1 Add a small line-LCS function in a new file `packages/tui/src/diff.ts` returning `Array<{ kind: 'same' | 'del' | 'add'; line: string }>`.
- [x] 4.2 Unit-test the LCS: equal inputs → all `same`; pure addition → only `same` + `add`; pure deletion → only `same` + `del`; complete replacement → only `del` + `add`; interleaved change → mixed sequence in correct order.

## 5. Renderer

- [x] 5.1 Rewrite `renderEditBody` in `packages/tui/src/ToolBody.tsx` to consume `startLine` / `contextBefore` / `contextAfter` from the tool result. Keep `renderEditBody` pure — no filesystem reads.
- [x] 5.2 Compute the gutter width from the largest line number that will appear in the hunk.
- [x] 5.3 Replace `diffRow` with a new row builder that takes `{ kind, lineNumber, content }`, emits the gutter + sigil + padded content, and applies `backgroundColor` on `del`/`add` rows.
- [x] 5.4 Pad content to `innerWidth` so the row background spans the full available width; keep the existing `clip` behavior for over-wide lines.
- [x] 5.5 Apply the `editDiffLines` cap to the **total** rendered row count (context + diff body + context) and append the existing `…N more lines` row when truncated.
- [x] 5.6 Implement the legacy fallback: when the tool result lacks `startLine`, emit the prior `-`-then-`+` rendering with no gutter and no backgrounds.

## 6. Renderer tests

- [x] 6.1 Test pure-addition snippet — assert one `+` row, surrounding context rows present, no `-` rows.
- [x] 6.2 Test pure-deletion snippet — assert one `-` row, surrounding context rows present, no `+` rows.
- [x] 6.3 Test interior unchanged lines — assert that lines common to old/new render as context, not as paired `-`/`+`.
- [x] 6.4 Test top-of-file (`contextBefore: []`) — no rows above the diff body.
- [x] 6.5 Test end-of-file (`contextAfter: []`) — no rows below the diff body.
- [x] 6.6 Test cap truncation — total rows exceed `editDiffLines` → exactly `editDiffLines` content rows + one `…N more lines` row.
- [x] 6.7 Test `NO_COLOR=1` produces no SGR sequences anywhere in the rendered output. _(Split across two layers: the renderer test in `ToolBody.test.tsx` only confirms it does not throw when `theme.status.successBg`/`errorBg` are `undefined`, since ink-testing-library strips ANSI. The substantive NO_COLOR invariant — that `plainTheme` does not define those tokens — is asserted in `packages/tui/test/theme.test.ts`.)_
- [x] 6.8 Test legacy fallback — tool result without `startLine` renders the old `-`/`+` pairs with no gutter or background.

## 7. Spec sync

- [x] 7.1 Run `pnpm -r build` and `pnpm -r test` to confirm cross-package builds (TUI consumes `@chimera/tools` via `dist/`). _(All 12 package suites pass except a pre-existing failure in `packages/cli/test/hooks.test.ts` caused by user-installed global hooks under `~/.chimera/hooks/` polluting the test — verified to fail identically on `main` without these changes.)_
- [x] 7.2 Run `openspec status --change improve-edit-diff-rendering` to confirm all artifacts are `done` and the change is ready to archive after merge.
