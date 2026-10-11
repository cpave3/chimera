## Context

The TUI prints finished transcript entries through Ink's `<Static>`, which is append-only: once an entry is printed it cannot change. Everything still changing lives in the live region below it (in-flight entries, spinner, modals, prompt, chrome). The Ink fork in use redraws the whole screen when the live region is as tall as the terminal.

`App` is one function of about 1,960 lines whose inner functions close over more than forty pieces of state.

## Goals / Non-Goals

**Goals:**

- A watcher can tell at a glance what the agent is doing and how long it has been at it.
- The transcript shows decisions and changes, not every file read.
- The chrome takes one row.
- `App.tsx` keeps state, effects and the JSX tree; everything else lives in a module named for what it does.

**Non-Goals:**

- A fullscreen TUI. The scrollback model stays (plan decision).
- New key bindings beyond `?` and `Ctrl+T`. Input work is package 6.
- Changing the event protocol.

## Decisions

### The split is mechanical

Pure helpers (`renderEntryLines`, `wrapToLines`, `renderPromptLines`, permission queue helpers) move as they are. The closures `apply` (session events), `handleSlash` and the `useInput` callback move to their own modules as functions that take one context object, destructured at the top under the same names, so each body moves verbatim. `App` builds the context at the call site, inside the same closure as before. The status-bar widgets move into a memoized `BottomChrome` component. Alternative considered: hooks that own slices of state. Rejected for the split: it would reorder hooks and state ownership, which is the behavior risk a pure move avoids.

### Grouping happens in the scrollback store, at commit time

The `Scrollback` store owns the commit cursor. A run of consecutive exploration calls (`read`, `glob`, `find`, `ls`, `grep`) is held as one group entry while it grows in the live region, showing a running count, and is committed as one line when the next entry of another kind arrives or the run ends. Because `<Static>` cannot re-render, the group is only committed once it is closed. A call that fails, or a `read` that returns an image, is never grouped.

### Detail lives in the transcript view

Expanding a group in place is impossible under `<Static>`. `Ctrl+T` switches to the alternate screen and renders the session from the scrollback store with every tool call on its own line and full tool bodies, with paging keys. Leaving it restores the normal screen untouched.

### The activity line is derived, not stored

One selector maps existing state to the line: an open permission request wins, then compaction, then a pending provider retry, then the most recent in-flight tool, then streaming text, else thinking. Elapsed time counts from the start of the run; tokens are the run's output tokens from `usage_updated`.

### Status row

One `StatusBar` row: mode (colored), model, `ctx N%`, `cache N%`, sandbox when not `off`, goal or task count on the right. The header box keeps cwd and session id. The hints row is removed; `?` on an empty prompt toggles a help panel in the live region.

### Syntax highlighting

`highlight.js` core with a small set of registered languages produces tokens; a mapper turns its classes into six theme tokens (`syntax.keyword`, `string`, `comment`, `number`, `function`, `type`). Unknown languages render as today. It applies to fenced code blocks only; diffs keep their add/remove colors.

### Approval prompt

`PermissionModal` renders a list. Up/Down move, Enter confirms, digits pick directly, Esc denies. The letter keys of the old prompt remain as aliases, so existing habits and tests keep working.

### Live region budget

The task panel shows at most 6 lines, queued messages 3, an in-flight group 1. A selector caps the total so the live region stays below the terminal height.

## Risks / Trade-offs

- [A handler captures a stale value after the split] → The context is built in the same closure and at the same time as the inline code ran.
- [Grouping hides a read the user wanted to see] → `Ctrl+T` shows every call; the group line names the count and the files when they fit.
- [The highlight library adds weight] → Core plus registered languages only; highlighting is skipped for blocks over 400 lines.
- [Flicker on small terminals] → The live-region cap, covered by frame tests at 80×24.
