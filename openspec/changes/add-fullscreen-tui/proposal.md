## Why

The inline TUI can only repaint the few rows under the terminal's own
scrollback. It cannot keep session facts, the plan, the working tree and the
context budget on screen while the transcript moves. The design prototype the
user chose ("C · Split with context panel") needs a screen the TUI owns.

## What Changes

- Add a fullscreen layout on the terminal's alternate screen: a scrolling
  transcript with the prompt on the left, and a context panel on the right.
- Make the fullscreen layout the default for the interactive TUI.
- Keep the present inline layout as a simpler mode for links where a
  fullscreen program works badly (for example SSH with high latency). Select
  it with `--inline` or `tui.layout: "inline"`.
- The context panel shows: model, session, sandbox, loaded skills and
  commands; context use by category; the plan (task list); the working tree
  (branch, changed files, line counts); other live Chimera instances; token
  totals.
- Scroll the transcript with PageUp/PageDown and the mouse wheel. Ctrl+B
  shows and hides the panel. A narrow terminal hides the panel.
- New default palette and surface colours (panel, raised, border) for the
  fullscreen layout. The inline layout keeps the ANSI palette.
- Restyle transcript lines for both layouts: `●` tool lines that sit
  together, `◆` on assistant text, a border around diffs.
- Add `GET /v1/sessions/:id/status`, a small status record that the panel
  reads from other instances.
- Print the session id and the resume command when a fullscreen session
  ends, because the alternate screen leaves no transcript behind.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tui`: fullscreen layout, context panel, transcript scrolling, layout
  selection, transcript line style.
- `tui-theme-system`: surface tokens and the fullscreen default palette.
- `cli`: `--inline` flag and `tui.layout` config key.
- `agent-server`: session status endpoint.

## Impact

- `packages/tui`: `App.tsx` splits into a controller and two views; new
  `FullscreenView`, `ContextPanel`, `worktree`, `scroll` modules; theme types.
- `packages/cli`: flag, config key, peers source, exit summary.
- `packages/server`, `packages/client`: status endpoint and client method.
- No change to the agent loop, tools or session format.
