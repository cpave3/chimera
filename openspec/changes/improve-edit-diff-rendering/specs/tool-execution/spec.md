## MODIFIED Requirements

### Requirement: `edit` tool

The `edit` tool SHALL accept `{ path: string, old_string: string, new_string: string, replace_all?: boolean }` and SHALL perform exact, non-regex string replacement.

It SHALL return:

```
{
  replacements: number,
  startLine: number,
  contextBefore: string[],
  contextAfter: string[]
}
```

where:

- `replacements` is the number of substitutions made.
- `startLine` is the 1-based line number in the **pre-edit** file at which `old_string` begins. When `replace_all` is true, `startLine` SHALL be the line number of the **first** match.
- `contextBefore` is the array of up to 3 lines from the pre-edit file immediately preceding `startLine`, in file order, top-of-file truncated when fewer than 3 lines exist above the match.
- `contextAfter` is the array of up to 3 lines from the **post-edit** file immediately following the replaced span, in file order, end-of-file truncated when fewer than 3 lines exist below.

The trailing newline of any captured line SHALL be stripped before insertion into `contextBefore`/`contextAfter`.

If `old_string` occurs zero times, the call SHALL error with message `"old_string not found"`. If it occurs more than once and `replace_all !== true`, the call SHALL error with message `"old_string matches N occurrences; pass replace_all=true or disambiguate"`.

#### Scenario: Unique match

- **WHEN** `edit` is called on a file where `old_string` appears exactly once and at least three lines exist both above and below the match
- **THEN** the file SHALL be rewritten with that single occurrence replaced by `new_string` and the result SHALL contain `replacements: 1`, a `startLine` equal to the 1-based line number of the first line of the match in the pre-edit file, a `contextBefore` array of length 3 holding the three lines immediately preceding the match, and a `contextAfter` array of length 3 holding the three lines immediately following the replaced span in the post-edit file

#### Scenario: Match at top of file

- **WHEN** `edit` is called on a file where `old_string` begins on line 1
- **THEN** `startLine` SHALL be `1` and `contextBefore` SHALL be an empty array

#### Scenario: Match at end of file

- **WHEN** `edit` is called on a file where `old_string` ends at the final line and no lines follow it
- **THEN** `contextAfter` SHALL be an empty array

#### Scenario: Ambiguous match

- **WHEN** `edit` is called with `replace_all` unset on a file where `old_string` appears twice
- **THEN** the file SHALL NOT be modified and the tool SHALL return an error result naming the count of matches

#### Scenario: Replace-all reports first match line

- **WHEN** `edit` is called with `replace_all: true` on a file where `old_string` appears multiple times
- **THEN** `replacements` SHALL equal the number of substitutions and `startLine` SHALL be the 1-based line number of the first occurrence in the pre-edit file
