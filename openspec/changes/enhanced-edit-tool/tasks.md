## 1. Tool Interface Update

- [ ] 1.1 Update `packages/cli/src/config.ts` (or appropriate tool definition file) to include the `isRegex` property in the `edit` tool arguments.
- [ ] 1.2 Update documentation and examples for the `edit` tool to demonstrate how to use the `isRegex` flag.

## 2. Core Implementation

- [ ] 2.1 Implement regex replacement logic in the `edit` tool using Node.js `String.replace`.
- [ ] 2.2 Implement the new `replace_lines` tool with support for `path`, `start_line`, `end_line`, and `content`.
- [ ] 2.3 Add unit tests for the `isRegex` functionality in `edit`, covering literal matches, simple regex, and complex regex patterns.
- [ ] 2.4 Add unit tests for the `replace_lines` tool, covering valid ranges, out-of-bounds errors, and empty content replacements.

## 3. Verification

- [ ] 3.1 Perform an end-to-end test using a subagent to perform a complex refactor that specifically requires regex (e.g., replacing all occurrences of a pattern with different whitespace).
- [ ] 3.2 Verify that existing `edit` calls (without `isRegex`) still function as literal matches and are not broken by the change.
