## Why

The TUI's current edit-tool diff renders every `old_string` line as `-` and every `new_string` line as `+` with no line numbers, no surrounding context, and no row-background highlight. When the snippet is large or only differs in a few lines, the user has to mentally diff the two halves to see what actually changed, and they can't tell where in the file the edit landed.

Claude Code's terminal renderer shows a few unchanged lines above and below the change, numbers every line in a gutter, paints `+`/`-` rows with a tinted background, and only highlights lines that actually differ between `old_string` and `new_string`. We want the same.

## What Changes

- The `edit` tool result SHALL carry enough information for the TUI to render a contextual hunk view: the starting line number of the match in the **pre-edit** file, plus a configurable number of unchanged lines immediately above and below the snippet (taken from the post-edit file content where they are stable, and from the pre-edit file for lines above the match).
- `renderEditBody` in `packages/tui/src/ToolBody.tsx` SHALL compute a line-by-line LCS diff between `old_string` and `new_string` so unchanged lines inside the snippet render as plain context rows, not as paired `-`/`+` rows.
- Edit-tool body rendering SHALL display:
  - A line-number gutter (right-aligned, muted color).
  - Unchanged context rows above and below the change (and inside the snippet, where LCS finds matches).
  - `-` rows with a red-tinted background spanning the full row width.
  - `+` rows with a green-tinted background spanning the full row width.
  - A `…` separator row when the rendered window is truncated against the existing `editDiffLines` cap.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `tool-execution`: the `edit` tool's result shape gains diff-context metadata (start line + before/after context lines) so the TUI can render a numbered, contextual hunk view.
- `tui`: tool-body rendering for `edit` calls gains a line-number gutter, surrounding-context lines, intra-snippet LCS diffing, and full-row background highlighting on `+`/`-` rows.

## Impact

- `packages/tools/src/edit.ts` (or equivalent): captures pre-edit file content around the match to populate the new result fields.
- `packages/tui/src/ToolBody.tsx`: rewrites `renderEditBody` and `diffRow`; introduces a small LCS helper.
- `packages/tui/test/`: new tests for the renderer covering pure additions, pure deletions, mixed hunks, snippets at file start/end (no context above/below), and width clipping.
- `packages/tools/test/`: edit-tool tests assert the new result fields.
- Spec deltas in `openspec/specs/tool-execution/` and `openspec/specs/tui/`.
- No breaking change for callers that ignore the new fields; the existing `replacements` field is preserved.
