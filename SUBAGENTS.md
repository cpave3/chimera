# Subagents

Chimera lets a parent agent delegate a focused task to a fresh "subagent"
via the built-in `spawn_agent` tool. Subagents are not a separate
abstraction — they are themselves Chimera instances driven through the
same `ChimeraClient` HTTP+SSE surface. That means everything you can do to a
top-level Chimera (attach, list, log, interrupt) you can do to a subagent.

## When to use

- **Investigations** that should not pollute the parent's context (e.g.
  "summarize what these 12 log files have in common").
- **Parallelizable work** — the AI SDK already parallelizes tool calls, so
  the parent can issue multiple `spawn_agent` calls in one step.
- **Tasks with a different toolset or model** — the parent picks the
  child's tool list, model, and (optionally) sandbox mode per-call.

## When NOT to use

- Trivial questions answerable inside one parent step.
- Tasks that need to keep the parent's full context (the parent only sees
  the subagent's *final* answer, not its tool calls).

## Inheritance rules

Children inherit:

- `--auto-approve` level from the parent (a `host`-level parent spawns
  `host`-level children).
- Project-scope permission rules — the child loads
  `./.chimera/permissions.json` from the same `cwd` like a top-level
  session.
- Sandbox mode by default. Override per-call with the `sandbox` and
  `sandbox_mode` arguments to `spawn_agent`.
- Model. Override per-call with the `model` argument.

The child does NOT inherit:

- Session-scope permission rules (those are per-session by definition).
- The parent's session messages — children start with empty history and
  receive only the `prompt` argument.

## Depth limits

`buildSpawnAgentTool` enforces a configurable max nesting depth (default
3). At `currentDepth >= maxDepth` the tool returns an `error` result
without spawning anything.

```
chimera --max-subagent-depth 5     # raise the cap
chimera --no-subagents             # disable spawn_agent entirely
```

## Child-process vs. in-process

By default subagents run as their own `chimera serve --machine-handshake`
child process. This costs ~500 ms per spawn but gives you full
observability: lockfile, attachable URL, log file, `chimera ls` entry.

For high-fanout research loops where the spawn time is prohibitive, pass
`in_process: true` in the `spawn_agent` arguments. In-process children:

- Run inside the parent's Node process (no separate `chimera serve`).
- Construct a fresh `LocalExecutor` and `PermissionGate` so they don't
  share session-scope state with the parent.
- Are NOT visible to `chimera ls`, NOT attachable, and don't write a
  lockfile — they're ephemeral.

## Interrupt cascade

`Ctrl+C` (or `Esc`) in the parent's TUI interrupts the parent's run. If
`spawn_agent` is in flight when that happens:

1. The tool calls `client.interrupt` on the child (fire-and-forget — the
   parent does not block on the child surfacing `run_finished`).
2. SIGTERM the child process.
3. SIGKILL after another 2 s if the process hasn't exited.

The parent's own `run_finished { reason: "interrupted" }` is held until
all children have torn down.

## Permission inheritance and headless behavior

If the parent has a TTY, child permission requests bubble up to the parent's
modal with a `[subagent <id>: <purpose>]` header. The user resolves them
the same way as parent prompts; the resolution is sent back to the child's
server.

If the parent has NO TTY (e.g. `chimera run "..."`), child host-target
permission requests that are not satisfied by a rule auto-deny — the child's
tool sees `denied by user` and continues. This avoids hangs in headless runs
and keeps subagents safe-by-default in CI.

**In-process children always auto-deny host permission requests**, even
when the parent has a TTY. Surfacing a permission prompt raised inside the
parent's own event loop would require re-entrant resolution; the simpler
invariant is "in-process is observation-only." If you need interactive
permission flow, drop `in_process: true` and use the default child-process
spawn.

## Debugging a running subagent

The most common reason to debug a subagent is "what is it actually doing?".
You have three options, ordered by ergonomics:

### 1. Watch in the parent's scrollback (always on)

Every `subagent_event` from a child surfaces in the parent's transcript with a
`[subagent <id>: <purpose>]` label, including its tool calls and any errors.
This is usually enough to understand what a misbehaving child is up to.

### 2. List, then attach from another terminal

For a full live view (deltas, intermediate output, permission prompts):

```
# In the parent's TUI:
/subagents

# Copy the printed subagentId, then in a second terminal:
chimera attach <subagentId>
```

This renders the child's stream identically to a top-level session. Closing
the attach terminal does not affect the child.

### 3. Drill into the child within the parent's TUI

`/attach <subagentId>` swaps the parent TUI's active session to the child's
server. Subsequent input goes to the child, and event rendering follows the
child. Useful when you only have one terminal pane.

## Surprises documented

- **Inheritance widens the child's surface, not narrows it.** A
  `--auto-approve host` parent spawns `host`-level children. If you want
  tighter child policy, override with explicit `spawn_agent` arguments
  (`tools`, `system_prompt`) in your parent prompt or system prompt.
- **In-process children are invisible to `chimera ls`.** Trade-off for the
  performance gain — covered in the spec.
- **Spawn time is ~500 ms** for a child-process subagent. Most of it is
  Node startup. Use `in_process: true` if you're spawning >10 children
  per turn.
