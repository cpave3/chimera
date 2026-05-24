## ADDED Requirements

### Requirement: JSON decision parsing

The hook runner SHALL, when a hook exits with code 0, attempt to parse the hook's stdout as a JSON object. If the stdout is empty or does not parse as valid JSON, the hook SHALL be treated as having made no decision. If the stdout parses as valid JSON, the runner SHALL extract decision fields from it and include them in `HookFireResult`.

The runner SHALL support the following top-level JSON fields:

- `decision`: `"block"` to block the action; omitted or any other value to allow
- `reason`: human-readable string explaining a block decision; presented to the agent as a retry message
- `additionalContext`: string added to the agent's context on the next turn
- `systemMessage`: string shown to the user in the UI
- `suppressOutput`: if `true`, the hook's stdout is not shown in the transcript
- `continue`: if `false`, stops the entire session after the hook runs; takes precedence over `decision`

The runner SHALL also support the `hookSpecificOutput` wrapper for Claude compatibility:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "..."
  }
}
```

If both top-level and `hookSpecificOutput` versions of the same field are present, the top-level value SHALL take precedence.

Hook output strings, including `additionalContext`, `systemMessage`, and plain stdout, SHALL be capped at 10,000 characters. Output exceeding this limit SHALL be saved to a file and replaced with a preview and file path.

#### Scenario: Hook returns block decision via JSON
- **WHEN** a hook exits 0 and writes `{ "decision": "block", "reason": "tests failed" }` to stdout
- **THEN** the runner SHALL set `HookFireResult.blocked = true`, `HookFireResult.reason = "tests failed"`, and parse the JSON into `HookFireResult.decision`

#### Scenario: Hook writes non-JSON text on stdout
- **WHEN** a hook exits 0 and writes `echo "lint complete"` to stdout
- **THEN** the runner SHALL treat it as no decision, set `blocked = false`, and the text SHALL be shown in the transcript

#### Scenario: Hook writes empty stdout
- **WHEN** a hook exits 0 with no stdout
- **THEN** the runner SHALL set `blocked = false` and take no special action

#### Scenario: Hook returns Claude-compatible hookSpecificOutput
- **WHEN** a hook exits 0 and writes `{ "hookSpecificOutput": { "hookEventName": "Stop", "additionalContext": "Remember to run tests" } }`
- **THEN** the runner SHALL extract `additionalContext` and include it in `HookFireResult.decision`

#### Scenario: Large additionalContext is capped
- **WHEN** a hook returns JSON with an `additionalContext` string longer than 10,000 characters
- **THEN** the runner SHALL truncate or write it to a temp file and pass a preview to the agent
