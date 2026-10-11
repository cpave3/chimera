## Context

`spawn_agent` blocks until the child ends. Parallel calls in one step already
run in parallel. Agent definitions are Markdown files found in tier
directories by `buildTiers`, which already accepts a `builtinDir` as the
lowest tier (modes use it). The factory builds the tool with a context object
that holds the parent's model, sandbox mode and event sink.

## Goals / Non-Goals

**Goals:**

- A search helper that works with no setup.
- One config key for every cheap helper call.
- A child that runs while the parent continues, without a new orchestration
  layer.

**Non-Goals:**

- Scheduling, dependencies between children, or a shared task board. Legato
  owns orchestration.
- A panel of children in the TUI. The transcript lines are enough for now.

## Decisions

### D1. Built-in definition in the lowest tier

`packages/subagents/builtin/explore.md` ships with the package and is found
through `builtinDir`. Shadowing a built-in is the supported way to change it,
so that collision gives no warning. Alternative: define `explore` in code.
Rejected: a file is the same format users write, and they can copy it.

### D2. `model: utility`

An agent definition names its model. `utility` is an alias the spawn tool
resolves to the `utilityModel` config key at call time, and to the parent's
model when the key is not set. An explicit `model` argument of the call still
wins. Alternative: a separate `utility: true` frontmatter key. Rejected: one
key already says which model.

### D3. `explore` tool list

`read, glob, grep, fetch, web_search`. The child's allowlist already maps
names for patch-shape models (`glob` admits `find` and `ls`), and a name with
no registered tool is ignored, so `web_search` appears only when configured.

### D4. Background children

`background: true` starts the child and returns `{ subagent_id, status:
"running" }`. A `BackgroundAgents` manager for the session holds each child:
purpose, state, result, and the means to stop it. The child is not tied to
the abort signal of the parent's run: interrupting the parent's run does not
stop it. `agent_stop` and the end of the session do.

When the child ends, the manager hands a message to the parent. The server's
`AgentRegistry` owns runs, so the delivery lives there (`deliver`): during a
run the message is queued for the next step boundary (the existing injection
path); when the session is idle it starts a run with that message; while a
compaction or a rewind holds the session it waits. The registry gives the
factory this function through an optional `setMessageDelivery` hook. The
message has a fixed first line (`[background agent <id> ended: <state>]
<purpose>`), says that it is not from the user, and holds the final answer.

A background child runs headless. Its events are dropped while the parent is
idle, so an approval request from it would wait for a prompt that never
opens; a command that needs approval is denied instead.

`chimera run` ends with its run and cannot wait for a child. There the
manager is absent, a `background: true` call runs in the foreground, and the
result carries a note that says so.

### D5. Transcript

`subagent_spawned` carries `background: true`. The TUI then shows no nested
rows for that child: its spawn line is finished the moment the call returns,
and rows under a finished line would break the commit order. The line for
the end of the child comes from the delivered message, which the TUI reads
back by its first line and shows as one event line instead of a user message.
That path also works when the child's own events were dropped.

## Risks / Trade-offs

- [A background child outlives the user's attention and spends tokens] → the
  depth limit applies, `agent_status` lists children, and session end stops
  them all.
- [A result arrives while the user types] → it starts a run only when the
  parent is idle, the same as a queued message.
- [`utilityModel` names a model that cannot be resolved] → the factory warns
  once at session start and uses the session model.
