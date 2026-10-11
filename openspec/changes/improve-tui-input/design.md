## Context

`attach-paths.ts` finds `@path` and `#path` tokens in a submitted message and grants read or write access to them. The slash menu shows completions for a buffer that starts with `/`. During a run, Enter calls `appendMessage`, which injects the text at the next step boundary; messages are queued only while a compaction or a `!` command blocks the session. `input/stdin-filter.ts` already intercepts terminal control sequences before Ink sees them.

## Goals / Non-Goals

**Goals:**

- Attach a file in a few keystrokes without leaving the prompt.
- Let the user choose between "tell the agent now" and "ask this next".
- Tell an absent user that the agent needs them.

**Non-Goals:**

- Completing skills, commands or symbols after `@`.
- Desktop notifications through a helper program. The terminal's own notification support is used; a `Stop` hook covers anything more.

## Decisions

### File completion mirrors the slash menu

The token under the cursor is the completion context: when it starts with `@` or `#` and has no whitespace, the rest is the query. Candidates come from `git ls-files --cached --others --exclude-standard` in the session's cwd, cached for five seconds; outside a git repository a bounded directory walk (skipping dot-directories and `node_modules`, at most 5,000 files) is used. Ranking is a pure function: a basename prefix match first, then a basename substring, then a path substring, then a subsequence match, with shorter paths first within a class. The list shows at most six rows. Accepting replaces the token with the marker, the path and a space.

### Tab queues, Enter steers

Codex uses Enter to steer and Tab to queue. Chimera's Enter already steers, so only Tab is new: during a run, with no menu open and a non-empty buffer, Tab moves the buffer into the queue. The existing drain at the end of a run sends queued messages as the next turn. The queue is rendered above the prompt within the rows `planLiveRegion` grants it, with a count of the rest. `Up` at an empty prompt pops the newest queued message into the buffer before it falls back to prompt history.

### Notifications through the terminal

`notify(reason)` writes BEL, and for `auto` also `OSC 9 ; text BEL`, which iTerm2, kitty, WezTerm, Ghostty and Windows Terminal show as a desktop notification and other terminals ignore. Focus is tracked with the `CSI ?1004h` focus-reporting mode: the stdin filter consumes `CSI I` and `CSI O` and records the state. Under `auto`, a notification is sent when the terminal is known to be unfocused; when no focus report was ever received, it is sent for approvals and input requests, and for a finished run only when the run lasted ten seconds or more.

## Risks / Trade-offs

- [`git ls-files` is slow in a huge repository] → It runs asynchronously, the result is cached, and the list shows what it has.
- [Tab is also the slash-completion key] → The slash menu and the file menu take Tab first; queueing applies only when neither is open and a run is active.
- [A terminal prints the OSC 9 sequence as text] → Terminals ignore unknown OSC sequences by specification; `tui.notifications: "bell"` or `"off"` is the escape hatch.
