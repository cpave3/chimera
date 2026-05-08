# TUI Code-Quality Review

Scope: `packages/tui/src/` and `packages/tui/test/`.

Severity: `[crit]` / `[high]` / `[med]` / `[low]`. Verified line citations.

---

## 1. Complexity Hot-Spots

- `[high]` **`App.tsx` — 1754 lines, grew from 1449.** The previous review flagged
  `handleSlash` for extraction; it is still inline at `L721` and now spans
  `L721` through `L1221` (~500 lines), handling `/help`, `/clear`, `/exit`,
  `/model`, `/rules`, `/new`, `/sessions`, `/fork`, `/subagents`, `/attach`,
  `/detach`, `/reload`, `/mode`, `/theme`, `/overlay`, `/apply`, `/discard`,
  and user-command dispatch. Several of these wrap async IIFEs that mutate
  scrollback state and call `setEntries(scrollback.all())` — the pattern is
  repeated ~80 times across the file. No extraction has happened since April.

- `[high]` **`App.tsx` — entry split & static/streaming logic (`L1273–1342`).**
  Still owns the `staticEntries` / `liveEntries` partition, subagent
  `childrenByParent` grouping, and `<Static>` vs live `<Box>` rendering all in
  one component.

- `[med]` **`scrollback.ts` — overlapping maps remain unconsolidated.**
  `toolsByCallId` (L95), `subagentParents` (L97), and
  `subagentToolsByCallId` (L100) still hold parallel state. The
  `subagent_event` handler (L447–520) still has five sub-cases inline.
  No `ToolRegistry` was extracted.

---

## 2. Type-Safety Gaps

- `[high]` **`App.tsx:1265`** — `remember as any` on `resolvePermission`. The
  `remember` parameter is already a clean discriminated union; the cast
  is unchanged from the April review. Also present in the sibling file:

- `[med]` **`PermissionModal.tsx:68`** — `{ scope: ... } as any` when
  `mode.pattern` is absent. The `onResolve` prop itself is typed as a
  discriminated union, but the component bypasses it with two `as any` casts
  (L59 and L68). The flow: when the user chooses "remember", the modal
  enters a `pattern` mode (which can be empty), then a `scope` mode that
  decides `session` vs `project`. On the `scope` branch the modal must
  decide whether to emit `{ scope: 'session' }` or `{ scope: 'project'; pattern; patternKind }`,
  but it currently emits `{ scope: 'session' }` through a cast, which does not
  actually match the `onResolve` parameter type everywhere.

---

## 3. Concurrency & Resource Issues

- `[high]` **`App.tsx` SSE subscribe `useEffect` (`L354–370`).** On the error
  branch the IIFE writes to scrollback and exits without attempting to close
  the async iterator or waiting for it to settle. If React unmounts and
  re-mounts (e.g. Fast Refresh or a strict-mode double-fire) while the
  previous `for await … subscribe()` is still alive, the new subscription
  may race with the old one. The cleanup only calls `controller.abort()` —
  but the async generator may not yield control immediately after the abort.

  Recommendation: add `await generator.return()` in the finally path, or
  track an epoch/mounted flag so that late callbacks from a replaced
  subscription are ignored.

---

## 4. Error-Handling Smells

- `[med]` **`scrollback.ts:safeFormat` (`L118–123`).** Catches formatter
  exceptions silently and returns `undefined`. This means a broken formatter
  causes a silent fallback to JSON args with no log. The TUI should at least
  emit a debug log so the user knows their theme/formatter is broken.

- `[low]` **`PermissionModal.tsx`** — `useInput` callback fires unconditionally
  for every keystroke even when the modal is not on screen (Ink dispatches
  to all mounted components). The handler uses early `return`s for the three
  modes, but the outer closure captures `props.onResolve` which may close
  over stale state if the parent re-renders between keystrokes. Not a bug
  today, but the modal should guard against resolving twice.

---

## 5. NEW Features Since April 26 — Review Findings

### 5.1 Multiline input (`input/buffer.ts`, `input/external-editor.ts`)

- **`input/buffer.ts`** — clean, pure, well-documented. All primitive operations
  (`insertChar`, `insertNewline`, `moveUp`, `moveDown`, etc.) are
  straightforward functions returning a new `MultilineBuffer`. The
  `endsWithUnescapedBackslashAtCursor` check is simple and correct.

- **`input/external-editor.ts`** — spawns `$EDITOR` via `child_process.spawn`
  with `{ stdio: 'inherit' }`. Correctly toggles raw mode and mouse sequences.
  However, the drain loop `while (stdin.read?.() !== null)` can race with
  Node's `readable` event — if data arrives between `read()` returning
  `null` and `setRawMode(true)`, it may leak into the TUI input parser. This
  is a **[med]** race on rapid editor exit.

### 5.2 Edit-tool diff rendering (`diff.ts`, `ToolBody.tsx`)

- **`diff.ts`** — `lineDiff` implements the classic LCS-table algorithm
  with O(n·m) memory. For the tool-body cap of 40 lines this is trivial,
  but the function is unbounded on raw file diffs; if it is ever used on
  larger inputs it will blow the stack. No line-length cap inside the diff.

- **`ToolBody.tsx`** — `renderEditBody` uses `as EditHunkResult` (L66) and
  `as { old_string?: string; new_string?: string }` (L63). These are
  unavoidable because the entry carries raw `unknown` tool args, but they
  should be validated rather than asserted. The `lineNumber` computation
  in the hunk renderer assumes `startLine` is 1-indexed, which is correct
  for the `edit` tool contract, but is not documented in the type.

### 5.3 Ctrl+Z suspend support (`App.tsx:510–513`)

- Simple and correct: `process.kill(process.pid, 'SIGTSTP')` with a platform
  guard for Windows. No issues.

### 5.4 Format tool entries during session rehydration (`scrollback.ts:193ff`)

- `rehydrateFromSession` walks persisted messages and applies synthetic
  events through `this.apply()`. It uses `safeFormat` (L118) when a formatter
  exists, falling back to JSON args. The AI-SDK v5 output unwrapping is
  handled but is itself brittle: it tests `part.type === 'tool-call'` then
  accesses `part.toolCallId` and `part.toolName` with casts — if the SDK
  changes field names this silently corrupts rehydration.

- Found a subtle bug: `seenCalls` is populated during assistant-message
  parsing, but the tool-result side (`msg.role === 'tool'`) looks up
  `seenCalls.get(toolCallId)` — if the session save/load reordered messages
  or if the result arrived without a matching call (truncation, error), the
  formatter call gets `undefined` args and may produce garbage.

### 5.5 Theme system (`theme/`)

- **`theme/loader.ts`** — `deepMerge` only merges the top five groups
  (`base`, `accent`, `status`, `text`, `ui`). Deep leaf merges are shallow;
  if a user theme overrides `base.prompt` but omits `base.user`, the user's
  `base` object replaces the whole group. This is intentional per the design
  doc, but means a typo in any key silently drops the default for the whole
  group rather than merging at the leaf level. Consider a warning for unknown
  keys.

- **`ThemeProvider.tsx`** — `reload()` callback is stable thanks to
  `useCallback`, good.

---

## 6. Permission Resolution Flow (`PermissionModal.tsx`)

- The component uses a small state machine (`ModalMode` union): `choose` →
  `pattern` → `scope`. The `useInput` hook runs on every keystroke. When
  the user presses `A` (allow + remember), it transitions to `scope` with
  `pattern: props.command`; when the user presses `g` (allow pattern), it
  transitions to `pattern` and lets the user edit the glob. After `Enter`,
  it transitions to `scope` with the edited pattern.

- The `as any` casts on L59 and L68 mean the compiler is not enforcing
  that the emitted object matches the `onResolve` contract. Since the parent
  (`App.tsx`) also casts with `remember as any`, both ends of the pipe are
  blind.

- No test exercises the full `choose → pattern → scope → resolve` flow in
  `PermissionModal`; `app.test.tsx` only tests the initial rendered text
  (L700–727).

---

## 7. Test Gaps

- `[high]` **No `App.tsx` integration tests for slash commands.**
  `app.test.tsx` (725 lines) covers header, prompt, footer, queuing,
  interrupt, subagent routing, initial prompt, and `PermissionModal` text.
  It does NOT exercise any of the 14 slash commands (`/help`, `/new`,
  `/sessions`, `/fork`, `/attach`, `/detach`, `/reload`, `/mode`, `/theme`,
  `/overlay`, `/apply`, `/discard`) or the permission-resolution end-to-end
  flow. These are the most user-facing code paths in the TUI.

- `[med]` **`diff.test.ts` only covers the pure `lineDiff` function.**
  There are no tests for `renderEditBody` with hunk metadata (gutter line
  numbers, context before/after, truncation logic, plain-theme fallback).

- `[med]` **`multiline.test.tsx` covers the high-level App integration**
  (backslash-Enter, literal newline, Ctrl+G editor handoff, history recall),
  which is good. But it does not test cursor vertical motion (Up/Down arrows
  across lines) or the sticky-column behaviour.

- `[med]` **`scrollback.test.ts` covers rehydrate formatters, but** no test
  asserts that `safeFormat` exceptions are silently swallowed — the
  "catches formatter exceptions" test only asserts that the entry still
  appears, not that nothing was logged.

- `[low]` **No test for SSE race.** The async iterator cleanup in the
  subscribe `useEffect` is not exercised in any test.

---

## Summary: Top 5 Actionable Fixes

1. **Extract `handleSlash`** from `App.tsx` into a standalone dispatcher
   module (the ~500-line function is the single biggest blocker to TUI
   maintainability).

2. **Remove `as any` casts** on the permission `remember` argument in both
   `App.tsx:1265` and `PermissionModal.tsx:59,68`. Chase the type through
   `ChimeraClient.resolvePermission` — it is already a union downstream.

3. **Consolidate scrollback maps** into a single `ToolRegistry` class that
   owns `toolsByCallId`, `subagentParents`, and `subagentToolsByCallId`.

4. **Add `finally` / `await generator.return()`** to the SSE subscribe
   `useEffect` so that re-subscription on `/attach` does not race with the
   previous iterator.

5. **Write integration tests** for the `PermissionModal` full flow
   (`choose → pattern → scope → resolve`) and for at least the most-used
   slash commands (`/new`, `/sessions`, `/theme`).

---

*Review date: 2026-05-08*
