## Why

The current `edit` tool is brittle because it relies on exact-string matching, making it highly susceptible to failures caused by whitespace, indentation, or invisible character discrepancies. This leads to high friction and increased cognitive load for the agent during refactoring tasks.

## What Changes

* **New Capability: Regex Replacement in `edit`**
  - Update the `edit` tool to support regular expression matching for the `old_string` parameter.
  - Introduce a new boolean flag `isRegex` (or similar) to toggle between literal and regex modes.
* **New Capability: Line-Range Editing**
  - Enhance the `edit` tool (or create a companion tool like `replace-lines`) that allows replacing content based on specific line numbers (`start_line`, `end_line`).

## Capabilities

### New Capabilities
- `regex-edit`: Enables robust text replacement using pattern matching, reducing failures caused by whitespace sensitivity.
- `line-range-edit`: Provides surgical precision for code modifications by targeting exact line ranges, eliminating the need to provide context strings.

### Modified Capabilities
- `edit`: The core `edit` tool will be extended with regex support and/or line-based replacement capabilities.

## Impact

- **Tooling**: Changes to the Chimera agent's internal toolset definitions and implementation in the `bash`/`edit` interface.
- **Relity**: Significant increase in the reliability of automated code refactoring and large-scale edits.
- **Complexity**: Slight increase in complexity for the `edit` tool implementation, but reduced complexity for agent task execution.
