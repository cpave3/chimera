## ADDED Requirements

### Requirement: Edit tool body shows contextual hunk

When the TUI renders the body of a successful `edit` tool call, it SHALL render a single hunk view derived from the tool result's `startLine`, `contextBefore`, `contextAfter`, and the call's `old_string`/`new_string` arguments. The hunk SHALL be rendered as a sequence of rows in this order:

1. One row per line in `contextBefore`, in file order.
2. The diff body of the snippet, computed as the line-level longest-common-subsequence of `old_string` and `new_string`. Each LCS entry SHALL produce one row:
   - Lines present in both strings render as **context** rows.
   - Lines only in `old_string` render as **removed** rows.
   - Lines only in `new_string` render as **added** rows.
3. One row per line in `contextAfter`, in file order.

Each row SHALL contain three visual segments rendered left-to-right after `paddingLeft = prefixLen`:

- A right-aligned **line-number gutter** rendered in the muted text color. The gutter width SHALL be the digit-width of the largest line number that appears in the hunk plus a single trailing space. Removed rows SHALL show their pre-edit line number; added rows SHALL show their post-edit line number; context rows SHALL show their line number in whichever side they originate from.
- A single-character **sigil**: `' '` for context, `'-'` for removed, `'+'` for added.
- The line **content**, clipped to the inner width with the existing `clip` helper, then right-padded with spaces to the inner width.

Removed rows SHALL render the sigil and content over a background tinted with the theme's removed-line background token. Added rows SHALL render them over a background tinted with the theme's added-line background token. Context rows SHALL have no background.

The total visible row count SHALL be capped at `TOOL_BODY_LIMITS.editDiffLines`. When the cap is exceeded, the renderer SHALL truncate from the bottom of the hunk and append the existing `…N more lines` row.

If the tool result is missing `startLine` (e.g., produced by a build of `@chimera/tools` predating this change), the renderer SHALL fall back to the prior behavior of emitting one `-` row per `old_string` line followed by one `+` row per `new_string` line, with no gutter and no row backgrounds.

The TUI SHALL continue to honor `NO_COLOR`: when set, the row backgrounds, foreground tints, and gutter color SHALL all be omitted.

#### Scenario: Pure addition inside a snippet renders unchanged surrounding lines as context

- **WHEN** an `edit` call is rendered where `old_string` is a four-line block and `new_string` is the same four lines with one extra line inserted between the second and third
- **THEN** the body SHALL render the surrounding `contextBefore`/`contextAfter` lines and four context rows for the unchanged lines, with exactly one `+` row for the inserted line, and no `-` rows

#### Scenario: Pure deletion inside a snippet

- **WHEN** an `edit` call is rendered where `new_string` equals `old_string` with one interior line removed
- **THEN** the body SHALL render exactly one `-` row for the removed line, surrounded by context rows for every other line in the snippet, with no `+` rows

#### Scenario: Match at top of file omits leading context

- **WHEN** an `edit` call is rendered with `contextBefore: []`
- **THEN** the body SHALL render no rows above the diff body

#### Scenario: Cap truncates from the bottom

- **WHEN** an `edit` call is rendered whose total row count (context + diff + context) exceeds `TOOL_BODY_LIMITS.editDiffLines`
- **THEN** the body SHALL render exactly `editDiffLines` content rows from the top of the hunk, followed by a single `…N more lines` row

#### Scenario: NO_COLOR strips backgrounds

- **WHEN** an `edit` call is rendered with `NO_COLOR=1` set
- **THEN** the rendered output SHALL contain no ANSI SGR sequences for foreground or background colors on any row

#### Scenario: Legacy result without startLine falls back

- **WHEN** an `edit` tool result lacks the `startLine` field
- **THEN** the renderer SHALL emit one `-` row per `old_string` line followed by one `+` row per `new_string` line, with no line-number gutter and no row background colors
