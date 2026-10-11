## Context

Every tool runs through `interceptTools` (package 3): a `before` hook may
answer a call without running the tool. Hooks are executables in
`~/.chimera/hooks/<Event>/` and `<cwd>/.chimera/hooks/<Event>/`; the `pre`
class (today only `PermissionRequest`) blocks on exit 2 or on a JSON
`{"decision":"block"}`, and fails open on any other failure or a timeout.
`registerMcpTools` connects to each server, lists its tools and adds one AI
SDK tool for each to the session's tool set.

## Goals / Non-Goals

**Goals:**

- A project rule that holds for every tool call, whatever the permission
  settings are.
- MCP servers cost context only when their tools are used.

**Non-Goals:**

- Rewriting tool input from a hook. A hook that changes what runs makes the
  transcript lie about what the model asked for.
- Deferring built-in tools. They are few and always needed.

## Decisions

### D1. `PreToolUse` is a pre-class event fired from an interceptor

The interceptor is first in the list, so it runs before the permission gate
(which lives inside the tool). The payload has `tool_name` and `tool_input`,
as `PostToolUse` has. A block gives the model the tool error `blocked by
PreToolUse hook: <reason>`. Exit 1, a crash, a missing interpreter and a
timeout fail open with a warning, as for every pre-class event: a broken
hook must not stop the agent. Alternative: fire it from the agent loop.
Rejected: the wrapper already sees every tool of every model profile.

### D2. The 10% rule

The cost of an MCP tool is its name, description and input schema as JSON,
at four characters a token. If the sum over all servers is at most 10% of
the session model's context window, every tool is registered as before.
Above it, none is, and `tool_search` is. The decision is made once, at
session start, for the model the session starts on.

### D3. `tool_search`

`tool_search({ query, limit })` scores each deferred tool by the query's
words in its name (weight 3), server name (2) and description (1), and
returns the best matches with their descriptions. The tools it returns are
registered on the agent at once; the tool result says they can be called
from the next step. An empty query lists servers with their tool counts,
without registering anything. A tool stays registered for the session, also
across mode and model changes (an MCP tool is outside the model profile's
tool surface, and a mode allowlist still filters it).

### D4. Adding a tool during a run

The agent reads its tool set at the start of each step. `Agent.addTools`
merges new tools into the set; the step in progress finishes with the old
set and the next step sees the new one. The system prompt's tool list is not
recomposed: MCP tools were never listed there.

## Risks / Trade-offs

- [The model does not think to search] → the `tool_search` description names
  the servers and says what kinds of tools they have.
- [Each activation costs a cache restart] → one restart for each search that
  registers something; searching again for registered tools registers
  nothing and costs nothing.
- [A hook slows every tool call] → hooks are opt-in, and the directory is
  scanned without spawning anything when it is empty.
