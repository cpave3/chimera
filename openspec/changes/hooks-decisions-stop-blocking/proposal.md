## Why

Chimera's hooks are a simple directory-based system that only supports binary decisions (exit code 0 vs 2) and only for pre-events (`PermissionRequest`). Users want quality-gate workflows — e.g., run biome lint after file edits, and if linting fails, reject the agent's stop attempt and force it to fix the problem. This requires: (1) structured JSON decisions from hooks, and (2) the ability for the `Stop` event to block.

## What Changes

- **Hook JSON decision parsing**: On exit 0, the runner now parses stdout as JSON. Supporting fields: `decision` (`"block"`), `reason`, `additionalContext`, `systemMessage`, `suppressOutput`, `continue`, and `hookSpecificOutput` (Claude compat).
- **Blockable `Stop` hooks**: `Stop` hooks (`run_finished.reason === "stop"`) are now fired synchronously by the agent *before* yielding `run_finished`. If a hook returns `{ "decision": "block" }`, the agent loops back into a fresh LLM turn with a system reminder message (e.g., "Lint errors found. Fix them before finishing.").
- **Safety cap on stop retries**: After 5 rejected stop attempts, the agent emits `run_finished` with `reason: "max_steps"`.
- **`PostToolUse` for `write`/`edit` enriches with file path**: The hook bridge now includes `tool_input.path` in the payload when a `write` or `edit` tool call finishes, so hooks can track which files were modified.
- **Event-bus bridge simplified**: `run_finished` no longer fires hooks via the async event-bus bridge (the agent now does it synchronously). All other event types remain fire-and-forget via the bridge.
- **Well-behaved `HookRunner` contract**: The `HookRunner.fire()` API returns a richer `HookFireResult` that carries parsed JSON fields. Existing hooks that exit 0 without valid JSON stdout are unaffected.

## Capabilities

### New Capabilities
- `hook-json-decisions`: Hooks can return structured JSON decisions on stdout (exit 0) to control behavior beyond simple exit codes.
- `stop-blocking`: `Stop` hooks can block an agent from finishing, forcing a retry turn with a system reminder.

### Modified Capabilities
- `lifecycle-hooks`: Requirement changes:
  - Exit-code semantics now covers JSON decisions on stdout (not just exit 2)
  - `Stop` changes from post-event (non-blockable) to blockable
  - New `HookFireResult` fields for parsed JSON output
  - Hook execution location: agent-core now fires `Stop` hooks synchronously (other events still fire from server)

## Impact

- `@chimera/hooks` — runner gains JSON parsing; `HookFireResult` gains new fields
- `@chimera/core` — `AgentOptions` gains optional `hookRunner`; `runInternal` gains retry loop
- `@chimera/cli` — factory wires `hookRunner` into `AgentOptions`
- `@chimera/server` — removes `run_finished → Stop` event bus mapping; event-bus bridge unchanged for other events
- `@chimera/permissions` — no changes; gate still fires `PermissionRequest` hooks the same way (uses exit 2, not JSON decisions), though JSON decisions would also work
- Breaking: Any existing hook that writes valid JSON with `"decision": "block"` on stdout would now block. Existing repos have none.
