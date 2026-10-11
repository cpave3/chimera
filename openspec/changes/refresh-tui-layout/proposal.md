## Why

The TUI shows three permanent status rows of bracketed widgets, a `you:` prefix, `[host]` badges on every tool line, and a spinner that only says `waiting…` or `streaming…`. A run of ten file reads fills the screen with ten lines. The permission prompt is a set of letter keys. `App.tsx` has 2,459 lines and owns every concern, which makes each of these hard to change.

This change covers packages 4 and 5 of the sota-uplift plan. Package 4 is a refactor with no requirement change, so it has no spec delta of its own and is task group 1 here.

## What Changes

- **Split `App.tsx`** into modules with one job each: transcript rendering, prompt rendering, bottom chrome, session events, slash dispatch, key handling, permission queue. No behavior change.
- **One status row**: mode, model, context use, cache share, sandbox. The key hints move to a panel that `?` opens on an empty prompt.
- **Activity line**: what the agent is doing (thinking, writing, running a tool, waiting for approval, compacting, retrying), elapsed time, tokens of the run, and the interrupt key.
- **Transcript**: glyph markers replace `you:` and the bracket badges; tool lines are muted; consecutive `read`, `glob`/`find`, `ls` and `grep` calls collapse into one line.
- **Transcript view**: `Ctrl+T` opens the whole session with full tool output on the alternate screen.
- **Task panel**: while a run is active, the task checklist shows above the prompt, at most 6 lines.
- **Code colors**: syntax highlighting for fenced code blocks, mapped to theme tokens.
- **Approval prompt**: a list operated with arrow keys and number keys. The existing letter keys keep working.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tui`: status row, activity line, transcript markers and grouping, transcript view, task panel, code highlighting, approval list.
- `tui-theme-system`: syntax color tokens.

## Impact

- `packages/tui`: `App.tsx` and new modules; `StatusBar`, `HintsBar`, `ChromeBar`, `PermissionModal`, `markdown.tsx`, `scrollback.ts`, theme tokens and presets.
- One new dependency for syntax highlighting.
- Docs: `README.md`, `docs/theme.json.example`.
