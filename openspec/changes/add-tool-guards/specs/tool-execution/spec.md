## ADDED Requirements

### Requirement: Whitespace-tolerant edit
When `old_string` has no exact match and `replace_all` is not set, `edit` SHALL match it against whole lines of the file, first ignoring trailing whitespace, then ignoring leading and trailing whitespace. A tolerant level SHALL apply only when exactly one place matches. When the match ignored indentation, `edit` SHALL re-indent `new_string` to the indentation of the matched lines. The result SHALL name the level that matched when it was not exact.

#### Scenario: Wrong indentation
- **WHEN** `old_string` equals a block of the file except that every line has two fewer leading spaces
- **THEN** the block is replaced, the new lines carry the file's indentation, and the result has `matched: "any-whitespace"`

#### Scenario: Trailing whitespace
- **WHEN** `old_string` equals a block of the file except for trailing spaces
- **THEN** the block is replaced and the result has `matched: "trailing-whitespace"`

#### Scenario: Ambiguous tolerant match
- **WHEN** `old_string` matches two places only after whitespace is ignored
- **THEN** the tool returns an error that names both line numbers and the file is unchanged

### Requirement: Closest block in edit errors
When `old_string` matches nothing, the `edit` error SHALL show the most similar block of the file with line numbers, at most 20 lines, when one is similar enough.

#### Scenario: One word differs
- **WHEN** `old_string` differs from a block of the file by one word
- **THEN** the error contains that block with its line numbers

#### Scenario: Nothing similar
- **WHEN** `old_string` resembles no part of the file
- **THEN** the error says the text was not found and shows no block

### Requirement: Tool-call interceptors
The system SHALL let interceptors run before and after every tool execution. An interceptor's `before` MAY answer the call without running the tool. An interceptor's `after` MAY replace the result or the error.

#### Scenario: Before answers the call
- **WHEN** an interceptor's `before` returns a result
- **THEN** the tool does not run and the model receives that result

### Requirement: Repeat note
When the model sends the same tool call three or more times in a row and each call has the same outcome, the result or error SHALL carry a note that tells the model to change approach.

#### Scenario: Same failing call three times
- **WHEN** a tool call with identical arguments fails with the same error three times in a row
- **THEN** the third error contains the note

#### Scenario: Different outcome
- **WHEN** a tool call with identical arguments returns a different result each time
- **THEN** no result contains the note

### Requirement: Output budget
When a tool result is larger than the active model's output budget, the system SHALL store the full result in the recall store, shorten each oversized text field to its beginning and end, and add the archive id to the result. Image results and results of the `recall` tool SHALL be exempt.

#### Scenario: Oversized command output
- **WHEN** a `bash` call returns output larger than the output budget
- **THEN** the result keeps `exit_code`, `stdout` holds the first and last lines around a marker, and `output_archived.id` names an entry whose content is the full output

#### Scenario: Result within budget
- **WHEN** a tool result is smaller than the output budget
- **THEN** the result is unchanged
