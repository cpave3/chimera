## Context

`edit` requires `old_string` to match the file byte for byte and answers `old_string not found` otherwise. The AI SDK validates tool-call arguments against the tool schema and turns a failure into a tool error for the model. Tool results go into the conversation whole; the recall store archives large results only later, during compaction. Nothing notices a model that repeats one failing call.

## Goals / Non-Goals

**Goals:**

- A wrong-whitespace edit succeeds when the intended place is unambiguous.
- A failed edit tells the model what the file really contains.
- Mechanical argument mistakes never reach the model as errors.
- One tool result cannot take more than the model profile's output budget.

**Non-Goals:**

- Fuzzy matching beyond whitespace. A hunk that differs in text is an error.
- Repairing arguments with a second model call.
- Stopping a run that loops. The step limit does that; the note gives the model a chance to recover first.

## Decisions

### Tolerant edit works on whole lines

When the exact search finds nothing, `edit` treats `old_string` as a block of lines and slides it over the file's lines, comparing with `trimEnd()` (level `trailing-whitespace`), then with `trim()` (level `any-whitespace`). Exactly one window must match; two or more is an error that names the line numbers. At the `any-whitespace` level the model's indentation was wrong, so `new_string` is re-indented: each of its lines that starts with `old_string`'s first-line indentation gets the file's indentation in its place. `replace_all` stays exact-only.

### Closest block in the error

For a miss, each candidate window is scored by the mean bigram similarity of its trimmed lines against `old_string`'s. The best window is shown with line numbers (maximum 20 lines) when its score is at least 0.5.

### Repair before validation fails

`streamText` accepts `experimental_repairToolCall`. The agent supplies a pure function that returns a corrected call or nothing. For an unknown tool it tries a case-insensitive match, a `functions.` prefix, and a small alias table (`shell` → `bash`, `read_file` → `read`, and the like). For invalid input it strips code fences, unwraps a double-encoded JSON string, and walks the tool's JSON schema to coerce `"true"`/`"false"` to booleans, numeric strings to numbers, JSON-array strings to arrays, and to drop `null` for optional properties. The SDK validates the repaired call again, so a bad repair still ends as the normal error.

### Interceptors wrap execution in one place

`interceptTools(tools, interceptors)` returns a tool set whose `execute` runs each interceptor's `before` (which may answer the call without running the tool) and `after` (which may replace the result or the thrown error). The factory wraps every tool surface once.

- **Repeat note.** Keeps the signature of the last call (name and canonical arguments) and of its outcome. On the third consecutive identical call with an identical outcome it adds a `note` to the result, or to the error message.
- **Output budget.** Reads the budget from the active model (`ModelConfig.outputBudgetTokens`, filled from the profile). When the serialized result exceeds it, the largest text fields are cut to a head and a tail around a marker line, then the largest lists to their first items, until the result fits. Each shortened field is archived on its own (a text as is, a list one item per line), so `recall` line ranges line up with the original output. The result keeps its shape, so scrollback formatters and agent logic that read fields keep working, and gains `output_archived: [{ field, id, tokens, omitted_items? }]`. Image results and the `recall` tool are exempt.

## Risks / Trade-offs

- [Re-indentation guesses wrong] → It only applies at the weakest level, the result says so, and post-edit diagnostics run as usual.
- [A coercion changes meaning] → Coercions follow the tool's own schema and only convert a string to the type the schema demands.
- [The repeat note fires on a legitimate poll] → It needs an identical outcome three times; `bash_output` returns only new output, so a live process does not match.
- [Truncation hides the part the model needed] → The full text is one `recall` call away, with line ranges and search.
