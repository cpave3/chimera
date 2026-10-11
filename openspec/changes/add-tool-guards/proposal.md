## Why

Tool calls fail for reasons that have nothing to do with the task: an `edit` whose `old_string` differs from the file by indentation, arguments sent as a JSON string or with `"true"` for a boolean, the same failing call sent again and again, and one oversized result that fills a small context window. These failures cost steps on every model and stop small models entirely.

This change replaces the unstarted `enhanced-edit-tool` proposal (regex and line-range edits). Regex adds escaping errors, and line numbers go stale after the first edit of a step. Tolerant matching and a useful error fix the same failures without a new edit mode.

## What Changes

- `edit` falls back to whitespace-tolerant matching when `old_string` has no exact match: first ignoring trailing whitespace, then ignoring indentation (re-indenting `new_string` to the file). A tolerant level must match exactly one place. The result reports the level.
- When nothing matches, the `edit` error shows the closest block of the file with line numbers.
- Invalid tool-call arguments are repaired locally before validation fails the call: code fences, arguments sent as a JSON string, string booleans and numbers, and `null` for optional fields. A wrongly cased or aliased tool name is mapped to the registered tool.
- When a call repeats three times in a row with the same result, the result carries a note that tells the model to change approach.
- A tool result larger than the model's output budget is stored in the recall store; the model gets the head and tail of each oversized text field plus a `recall` id.
- A tool-call interceptor wraps tool execution in one place. The repeat note and the output budget are interceptors; package 10 adds the `PreToolUse` hook the same way.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tool-execution`: tolerant edit, edit error context, repeat note, output budget, tool-call interceptors.
- `agent-core`: tool-call repair.

## Impact

- `packages/tools`: `edit.ts`, new `intercept.ts`, `guards.ts`.
- `packages/core`: new `tool-repair.ts`, `agent.ts`, `types.ts` (`ModelConfig.outputBudgetTokens`).
- `packages/cli`: `factory.ts` wraps each tool surface.
- `packages/tui`: tool line shows the match level and the archive id.
- Docs: `README.md`.
- Removes `openspec/changes/enhanced-edit-tool`.
