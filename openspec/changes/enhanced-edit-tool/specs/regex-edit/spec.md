## ADDED Requirements

### Requirement: Regex-based editing in `edit` tool
The `edit` tool SHALL support regular expression matching for the `old_string` parameter when requested.

#### Scenario: Successful regex match and replace
- **WHEN** the user calls `edit` with `old_string` set to a valid regex pattern (e.g., `const .* =`) and `isRegex` set to `true`
- **THEN** the tool SHALL find all occurrences matching the pattern in the target file and replace them with the `new_string`

#### Scenario: Regex match fails (no matches found)
- **WHEN** the user calls `edit` with a regex pattern that does not exist in the target file
- **THEN** the tool SHALL return an error indicating that no match was found, maintaining existing behavior for non-matches

### Requirement: Surgical line-range replacement via `replace_lines`
A new tool `replace_lines` SHALL be provided to allow replacing a specific range of lines in a file without providing surrounding context.

#### Scenario: Successful line range replacement
- **WHEN** the user calls `replace_lines` with `path`, `start_line`, `end_line`, and `content`
- **THEN** the tool SHALL remove all lines from `start_line` through `end_line` (inclusive) and insert the new `content` at that location

#### Scenario: Replacement out of bounds
- **WHEN** the user provides a `start_line` or `end_line` that exceeds the actual line count of the file
- **THEN** the tool SHALL return an error indicating the invalid line range
