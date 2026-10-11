## Context

The TUI renders with `@jrichman/ink` 6.6.9. The inline layout prints
finished transcript entries once through `<Static>` and repaints a small live
region. The fork also has an alternate-screen renderer with line-level
incremental writes, a scroll box (`overflowY="scroll"`, `scrollTop`), a
cached subtree (`StaticRender`) and `useApp().rerender()`.

A spike measured a 100-column transcript in a scroll box, repainted 30 times
a second:

| Entries | Plain | With `StaticRender` |
| --- | --- | --- |
| 200 | 13.5 ms | 4.6 ms |
| 1,000 | 62.6 ms | 12.1 ms |
| 3,000 | 216.7 ms | 34 ms |

## Goals / Non-Goals

**Goals:**

- Match artboard C of the prototype: split layout, context panel, filled
  prompt box, mode badge.
- Keep frame time flat for long sessions.
- One controller for both layouts, so a feature lands in both.

**Non-Goals:**

- Selection beyond what is on screen (no auto-scroll while dragging), and
  word or line selection by double or triple click.
- Cost in money. No price data exists in the configuration.
- A second transcript renderer. Both layouts draw entries with the same
  function.

## Decisions

### D1. One controller, two views

`App` keeps all state, effects and handlers and builds one `AppView` object.
`InlineView` and `FullscreenView` only draw. Modals and pickers move into a
shared `Dialogs` component, and their handlers move into the controller.
Alternative: a second App for fullscreen. Rejected: two copies of 900 lines
of session logic.

### D2. Transcript in a scroll box, cached and windowed

Finished entries are wrapped in `StaticRender`, keyed by entry id, width and
theme, so a resize or a theme change draws them again. Entries past the
commit cursor are drawn live. The view mounts the newest 300 entries and
adds 300 more when the user scrolls to the top. Alternative: full
virtualization with measured heights. Rejected: more code than the window
needs, and the spike shows the window keeps a frame under 6 ms.

### D3. Scroll state

The view follows the tail by default (`scrollTop` far past the end; the fork
clamps it). The first scroll up reads the real scroll height and pins an
absolute `scrollTop`, so new output does not move the text the user reads.
Scrolling back to the end, sending a message or pressing End follows the
tail again.

### D4. Mouse: wheel and selection

Fullscreen enables SGR mouse reporting with button events and motion while a
button is down (`?1002h ?1006h`). The stdin filter takes the reports out of
the key stream. The wheel scrolls the transcript.

While the TUI takes mouse reports the terminal cannot select for the user,
and in tmux the Shift bypass selects across panes. So the TUI selects
itself. The Ink fork has a DOM-style selection, but it is undocumented and
tied to its caches; the selection here works on the screen instead: the
mount keeps the last frame Ink drew (`onRender`), a drag paints a highlight
over it with direct writes, and the frame's own rows are written back when
the selection moves or ends. Ink's line-diffing writer rewrites the rows it
changes, so the highlight is painted again after each frame. The layout
reports its selectable regions (transcript column, panel text), and a
selection stays in the region it starts in. On release the text goes to the
clipboard both ways: the system tool (`wl-copy`, `xclip`, `xsel`, `pbcopy`;
not over SSH) and OSC 52. `tui.mouse: false` turns all of it off.

### D5. Layout choice

`--inline` or `tui.layout: "inline"` selects the inline layout. Fullscreen
is the default. Without a TTY on stdout, or with `TERM=dumb`, the TUI uses
the inline layout.

### D6. Palette

Fullscreen paints its own background, so its default palette is the
prototype's hex palette with surface tokens. The inline layout sits on the
user's terminal background and keeps the ANSI palette. A user theme merges
over either. `NO_COLOR` keeps the plain theme in both; the panel then
separates with a border line only.

### D7. Panel data

- Context: `GET /v1/sessions/:id/context` after each usage update. Skills
  share is the size of the skills index; system is the rest of the system
  prompt; history is what remains of the provider's count.
- Plan: the task list the TUI already tracks.
- Working tree: `git status --porcelain=v2 --branch` and
  `git diff --numstat HEAD`, read at start and after each tool result and
  run end, at most once in 400 ms.
- Peers: live lockfiles in `~/.chimera/instances/` other than this process,
  with `GET /v1/sessions/:id/status` on each, every 5 s.

### D8. Handoff to an editor or pager

A child program leaves the alternate screen when it exits. After a handoff
the fullscreen layout enters the alternate screen again, restores mouse
reporting and asks Ink for a full repaint.

## Risks / Trade-offs

- [No terminal scrollback of the session] → Ctrl+T still opens the full
  transcript in a pager; the exit line gives the resume command.
- [Mouse capture hides native selection] → Shift+drag; `tui.mouse: false`.
- [A peer on an older build has no status endpoint] → the peer shows without
  a state.
- [Overlay sandbox: host tree does not change] → the working tree section
  shows the host tree only; `/apply` remains the view of overlay changes.
