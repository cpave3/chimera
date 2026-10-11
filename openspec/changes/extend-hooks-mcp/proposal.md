## Why

A hook can see a tool call only after it ran (`PostToolUse`), or when the
permission gate is about to prompt (`PermissionRequest`). A project cannot
say "never run this" for a call the gate allows on its own. And every
configured MCP server puts all its tool schemas into every request, whether
the task needs them or not; a few large servers take a real share of a small
model's context.

## What Changes

- A `PreToolUse` hook, fired before each tool call. It can block the call;
  the model then gets the hook's reason as the tool error. It cannot change
  the tool's input.
- Deferred MCP tools. When the MCP tool schemas would take more than 10% of
  the context window, Chimera does not register them at session start. It
  registers `tool_search` instead, which finds MCP tools by name and
  description and registers the ones it returns for the rest of the session.
  Under the limit nothing changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `lifecycle-hooks`: the `PreToolUse` event.
- `tool-execution`: deferred MCP tools and `tool_search`.

## Impact

- `packages/hooks`: the new event in the types and the pre class.
- `packages/cli`: an interceptor that fires the hook; MCP registration splits
  into "describe" and "register"; `tool_search`.
- `packages/core`: the agent accepts a tool added during a run.
- A session with deferred tools restarts the provider's prompt cache once
  for each `tool_search` call that registers a tool.
