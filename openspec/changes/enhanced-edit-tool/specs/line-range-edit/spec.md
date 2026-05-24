## ADDED Requirements

### Requirement: Surgical line-range replacement via `replace_lines`
A new tool `replace_lines` SHALL be provided to allow replacing a specific range of lines in a file without providing surrounding context.

#### Scenario: Successful line range replacement
- **WHEN** the user calls `replace_lines` with `path`, `start_line`, `end_line`, and `content`
- **THEN** the tool SHALL remove all lines from `start_line` through `end_line` (inclusive) and insert the new `content` at that location

#### Scenario: Replacement out of bounds
- **WHEN** the user provides a `start_line` or `end_line` that exceeds the actual line count of the file
- **THEN** the tool SHALL return an error indicating the invalid line range
