## Context

The TUI renders tool calls inline in the scrollback. For `edit`, the renderer is `renderEditBody` at `packages/tui/src/ToolBody.tsx:33-62`. It receives the tool's `args` (`{ path, old_string, new_string, replace_all? }`) and result (`{ replacements }`), splits both strings on newlines, and emits one `-` row per old line followed by one `+` row per new line, capped at `TOOL_BODY_LIMITS.editDiffLines = 40`. There are no line numbers, no surrounding context, and no row-background colors; the foreground colors come from `theme.status.error`/`theme.status.success`.

The constraint we have to work within: the TUI is event-driven and stateless about the workspace — it sees `tool_call_start` / `tool_call_end` events but does not have direct access to the file before or after the edit. Anything we want to render about the file's surrounding lines has to come through the tool result (or be re-derived from the file at render time, which is racy because subsequent tool calls may have changed the file).

The edit tool itself lives in `@chimera/tools` and currently returns `{ replacements: number }` (see `openspec/specs/tool-execution/spec.md:97-111`).

## Goals / Non-Goals

**Goals:**
- Match Claude Code's edit-diff visual: line numbers in a gutter, a few unchanged context lines above and below the change, full-row red/green background for `-`/`+` rows, and unchanged lines in the middle of the snippet rendered as plain context (not as paired `-`/`+`).
- Keep the TUI deterministic: do not re-read the file at render time.
- Preserve the existing `editDiffLines` cap and graceful overflow ("…N more lines") row.
- Stay within the existing event/data flow — no new client-server round-trips.

**Non-Goals:**
- Word-level intra-line highlighting (Claude's renderer doesn't reliably do this in the screenshot, and it's a much larger lift).
- Rendering edits as multi-hunk diffs across non-contiguous regions of the file. The `edit` tool only ever touches one contiguous span (the unique match of `old_string`), so a single hunk is sufficient.
- Changes to the `write` or `bash` tool body renderers.

## Decisions

### Decision 1: Capture context in the tool, not the TUI

The `edit` tool already has the pre-edit file content in memory (it has to, to find the match and write the replacement). It will capture the surrounding lines and the 1-based start line of the match before writing, and include them in the result.

**Alternative considered:** have the TUI read the file when the event arrives. Rejected because (a) the file may have been modified by a later tool call, producing stale or wrong context, and (b) it adds filesystem coupling to the renderer. Capturing at edit time is correct-by-construction.

The result shape becomes:

```ts
type EditResult = {
  replacements: number;
  startLine: number;          // 1-based line number where old_string starts
  contextBefore: string[];    // up to N lines immediately before startLine, top-of-file truncated
  contextAfter: string[];     // up to N lines immediately after the matched span
};
```

`N` is fixed at **3** in the tool (matches Claude's screenshot). The TUI may render fewer if the cap is hit, but does not request more — the tool decides the budget.

### Decision 2: LCS for intra-snippet diffing

Inside the snippet, lines that appear in both `old_string` and `new_string` should render as plain context, not as a `-`/`+` pair. Standard line-level Myers/LCS gives the right behavior. We'll implement a small (~40 line) LCS that returns a sequence of `{ kind: 'same' | 'del' | 'add', line: string }` entries.

**Alternative considered:** use an existing diff library (`diff`, `fast-diff`). Rejected — they're heavyweight for one usage site, and a hand-rolled line-LCS is small and easy to test. We already avoid runtime deps where the code is trivially small (see existing TUI helpers).

### Decision 3: Row layout and the gutter

Each rendered row is:

```
<paddingLeft = prefixLen> <gutter: line# right-aligned, muted> <sigil: ' ' | '-' | '+'> <line content, clipped, padded to innerWidth>
```

Background highlight is applied to the `Text` containing the sigil + content (not the gutter), via `<Text backgroundColor={...}>`. Padding the content to `innerWidth` is what makes the bg span the row. The gutter width is `String(maxLineNumber).length`.

Sigil/foreground/background mapping:
- `same` → sigil `' '`, fg `theme.text.muted`, no bg.
- `del`  → sigil `'-'`, fg `theme.status.error`, bg `theme.status.errorBg` (new theme token).
- `add`  → sigil `'+'`, fg `theme.status.success`, bg `theme.status.successBg` (new theme token).

The two new theme tokens default to a low-saturation tint of the existing fg colors (e.g. ~10–15% lightness for dark themes, ~90% for light). Each existing theme adds them; without them the renderer falls back to no background, which preserves current behavior.

### Decision 4: Cap behavior

Total visible rows = `contextBefore.length + diffEntries.length + contextAfter.length`. If that exceeds `editDiffLines`, we render up to the cap and append the existing `moreLinesRow`. We do *not* try to be clever about preserving balance between leading/trailing context — the cap is a hard truncation from the bottom, same as today.

### Decision 5: Backwards compatibility

The TUI consumes the new fields through optional access. If a tool result is missing `startLine` (e.g., from a stale fixture or an in-flight session that started before the upgrade), the renderer falls back to the current "all `-` then all `+`" path. This costs ~10 lines and avoids spurious test churn.

## Risks / Trade-offs

- **Pre-edit context capture adds ~6 string operations per edit.** → Negligible; the tool already does line-splitting work to find the match.
- **Theme tokens vary across themes; some users may have custom themes without the new bg tokens.** → Renderer falls back to no background, identical to today's look. Documented in the theme-system spec delta.
- **LCS is O(m·n) on snippet size.** → Edit snippets are small in practice (the cap is 40 lines total). No concern.
- **Truncation hides the trailing context window when the change is large.** → Acceptable; matches existing cap semantics. Users wanting full diffs can still open the file.
- **Edit fixture/test churn from new result fields.** → Bounded; tests that only assert on `replacements` continue to pass. Tests that round-trip the result need updating.

## Migration Plan

1. Land tool change first (capture context + new result fields) behind a result that's a strict superset of today's. Existing TUI keeps working — it just ignores the new fields.
2. Land theme tokens with sensible defaults across all built-in themes.
3. Land TUI renderer change (LCS + gutter + bg). Snapshot/Ink-testing assertions updated.
4. No flag, no rollback knob — purely additive UI change.

## Open Questions

- Should `contextBefore`/`contextAfter` length be configurable per-call (e.g. by the model) or fixed at 3 in the tool? **Tentative answer: fixed at 3.** Easy to revisit; not worth the API surface now.
- Should we also surface this richer view through the JSON-mode (`chimera serve` text output) consumers? **Out of scope for this change.** The new fields are present in the event payload; non-TUI consumers can render them when they want to.
