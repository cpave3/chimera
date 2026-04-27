## Context

`chimera-mvp` reserved the subagent seams: `AgentEvent` carries the subagent variants; `chimera serve --machine-handshake` emits the ready-line; `--parent` carries the parent session id through `/v1/instance`; `listSubagents` is typed on `ChimeraClient`. What's missing is the tool that spawns a child, wires its event stream into the parent's, and cleans up. This design records the choices §11 leaves implicit.

## Goals / Non-Goals

**Goals:**

- `spawn_agent` is a normal AI-SDK tool — the model can't tell it's special.
- Child-process path is the default so every subagent shows up in `chimera ls` and is attachable.
- In-process path exists for high-fanout research loops where 500 ms and a fresh Node per call is prohibitive.
- No special-case code paths in server / client for subagents — they just use the same HTTP+SSE surface as any other consumer.

**Non-Goals:**

- Named subagent configs / auto-delegation (`spec.md` §18, V2).
- Cross-process tool-result streaming (subagents return a single `result` string).
- Token-cost roll-up visible to the parent model during the run (only in `subagent_finished.usage`).
- Nested host-permission bubble-up beyond depth 1 without a TTY. MVP+subagents auto-denies in that case; a future change can add a general `--permission-prompt-via` chain.

## Decisions

### D1. `spawn_agent` blocks the parent's tool loop until the child finishes

**Decision:** Like any other tool, `spawn_agent` returns a single `{ result, reason, steps, ... }` object. The parent model does not see streaming output from the child; it sees the child's final assistant text as the tool result.

**Why:** Matches AI SDK tool shape. Keeping the parent loop unaware of child streaming prevents context pollution and means the model's decision-making uses the child's conclusion, not its intermediate babble.

**Cost:** Parent's wall-clock stalls on the child. If the parent wants parallelism, it issues multiple `spawn_agent` calls in one step (AI SDK already parallelizes tool calls).

### D2. Child's event stream is re-emitted, not hidden

**Decision:** Every event the child emits becomes a parent `subagent_event { subagentId, event }`. The TUI renders them nested; the SDK consumer can filter them out if it prefers the summary.

**Why:** Matches `spec.md` §11 and is what makes the child's permission prompts visible to the parent's TUI.

### D3. Child-process handshake reads exactly one stdout line

**Decision:** `chimera serve --machine-handshake` prints one JSON line on ready and then nothing more to stdout. The parent reads exactly that line from the child's stdout pipe, parses it, and stops reading stdout. stderr stays open for normal logging.

**Why:** Exact-line protocol is trivially parseable and avoids buffering gotchas around newline-delimited streams.

**Failure handling:** If the child exits before emitting the line or emits invalid JSON, the parent closes the pipe, SIGTERMs the child, and the tool returns `{ reason: "error", result: "<diagnostic>" }`.

### D4. In-process mode shares nothing that leaks state across instances

**Decision:** `in_process: true` calls `new Agent({...})` in the same Node process but constructs a fresh `LocalExecutor`, a fresh `PermissionGate` (with parent rules loaded but session rules disjoint), and a fresh session. The parent's `AbortController` is still honored via composition.

**Why:** No shared in-process state prevents accidental contamination (rule leaks, session-id collisions). The only "shared" thing is the Node VM.

**Trade-off:** Memory footprint is still larger than pure function calls — but far less than a full child Node process.

### D5. Depth limit lives in the tool, not the agent loop

**Decision:** `buildSpawnAgentTool(ctx)` takes `currentDepth` and `maxDepth`; if `currentDepth >= maxDepth`, the tool returns `{ error: "max subagent depth reached" }` without spawning. Children inherit `currentDepth + 1`.

**Why:** Enforces the cap at the exact point a spawn would happen, so every tool call visibly records whether it was permitted.

### D6. Interrupt cascade uses the existing `AbortController`

**Decision:** `Agent.interrupt()` on the parent aborts any in-flight tool call, including `spawn_agent`. The `spawn_agent` implementation, on abort, (a) calls `client.interrupt(childSessionId)`, (b) waits up to 5 s for `run_finished { reason: "interrupted" }`, (c) SIGTERMs the child process, (d) SIGKILLs after another 2 s.

**Why:** Reuses existing plumbing; no new interrupt channel.

### D7. Permission bubble-up is deliberately limited in V1

**Decision:** If the parent has a TTY, child permission requests render in the parent's TUI (via `subagent_event`) and the user resolves them. If the parent has no TTY, child host-target permission requests auto-deny (tool returns "denied by user"). No `--permission-prompt-via` chaining in this change.

**Why:** Matches `spec.md` §11.3 V1 simplification. Chained bubble-up has subtle deadlock cases that warrant their own change.

## Risks / Trade-offs

- **[Orphaned child processes on parent crash]** → Mitigation: write the child lockfile before `spawn_agent` returns; `chimera ls` cleans stale entries. Users can SIGKILL surviving children by PID from the lockfile.
- **[Port exhaustion at high fanout]** → Mitigation: in-process mode explicitly targets this case; default stays child-process.
- **[Child inherits parent's rules — surprise widening]** → Documented in `SUBAGENTS.md`; per `spec.md` §20 open question, we chose inheritance = least surprise.
- **[Spawn time of ~500 ms per child]** → Documented; in-process opt-in.

## Migration Plan

Additive. Users on MVP see no change unless they opt into providing a `spawn_agent` description in their project's system prompt or let the default model pick it up. Rollback: `--no-subagents` at runtime, or `git revert` the merge.

## Open Questions

- Should the default `timeout_ms` for a subagent be 10 min (per `spec.md` §20) or model-configurable with a sensible default? Proposed: **10 min default, overridable per-call**. Revisit once we observe real use.
- How should `listSubagents` report children that have exited? Proposed: omit them; `chimera sessions` with the `parentId` filter is the place to find historical ones.
