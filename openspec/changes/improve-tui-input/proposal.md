## Why

Three everyday input gaps. Attaching a file means typing its whole path after `@`; the TUI parses `@path` but offers no completion. A message typed during a run can only steer the run; there is no way to hold it for the next turn, and queued messages are invisible apart from a one-line count. And nothing tells a user who has switched windows that a long run finished or is waiting for approval.

## What Changes

- `@` (read) and `#` (write) open a file list with fuzzy matching. Up and Down move, Tab or Enter accepts, Esc closes. The list comes from `git ls-files`, with a directory scan as the fallback.
- During a run, `Enter` keeps steering the run and `Tab` holds the message for the next turn. Queued messages are listed above the prompt. `Up` at an empty prompt takes the last queued message back for editing. The `queued: …` transcript lines are removed; the list replaces them.
- When a run ends, needs approval, or asks for input, the TUI sends a terminal bell and an OSC 9 notification. With the default setting it does so only when the terminal reports that it lost focus, or, for terminals that do not report focus, when the run lasted ten seconds or more. `tui.notifications` in `config.json` takes `auto`, `bell` or `off`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tui`: file completion, queue for the next turn with a visible list, notifications.
- `cli`: the `tui.notifications` config key.

## Impact

- `packages/tui`: `App.tsx`, `key-handler.ts`, `slash-dispatch.ts`, `input/stdin-filter.ts`, `mount.tsx`, new `file-completion.ts`, `FileMenu.tsx`, `QueueList.tsx`, `notify.ts`.
- `packages/cli`: `config.ts`, `commands/interactive.ts`.
- Docs: `README.md`.
