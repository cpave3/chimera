## Context

Chimera's hook system (`@chimera/hooks`) today discovers executable scripts from `~/.chimera/hooks/<Event>/` and `<cwd>/.chimera/hooks/<Event>/`, passes a JSON payload on stdin, and interprets the exit code: 0 = allow, 2 = block (only for `PermissionRequest`), anything else = warning. Stdout is drained to a no-op handler to prevent pipe deadlock and never parsed.

Claude Code's much richer hook system supports JSON decisions on stdout (exit 0): `{ "decision": "block", "reason": "..." }`, `{ "additionalContext": "..." }`, etc. This enables workflows like quality gates that inspect code and reject the agent's stop attempt.

The user's specific request is to run linting after file edits (`PostToolUse`) and reject stop (`Stop`) if linting fails. The existing system cannot do this because: (1) `Stop` is classified as a post-event and cannot block, (2) hooks have no structured output channel beyond exit codes.

## Goals

- JSON decision parsing from stdout on exit 0 (backward compat: non-JSON stdout = no decision)
- `Stop` hooks can block, forcing an extra agent turn with a system reminder message
- Stop retry safety cap (5 attempts) to prevent infinite loops from a malicious/persistent hook
- Existing hooks that exit 0 with plain text or empty stdout continue working unchanged
- Claude-compatible `hookSpecificOutput` wrapper also parsed for portability

## Non-Goals

- New hook events (e.g., `PreToolBatch`) — out of scope
- HTTP/prompt/agent hook types (Claude has these, Chimera is command-only today)
- `PostToolUse` blocking (Claude explicitly says "tool already ran" for this event)
- Matcher/filtering beyond directory + execute-bit (e.g., per-filename regex)

## Decisions

### 1. Where should the `Stop` hook be awaited?

**Decision:** Inside `Agent.runInternal()` in `@chimera/core`, before emitting `run_finished`.

**Rationale:**
- The agent's async generator returns `AgentEvent`s. If we block on the event bus (server layer), we'd need to prevent `run_finished` from being emitted, which means suppressing it after the agent already yielded it. That requires either (a) a proxy stream that intercepts events, or (b) modifying the agent-core to yield a different terminal event if stop is blocked.
- By putting the `Stop` hook inside `runInternal`, we simply don't emit `run_finished` (don't exit the loop) until the hook allows it. The retry is transparent to all consumers (TUI, client API, subagents).
- This means `@chimera/core` now optionally depends on `@chimera/hooks` (via `AgentOptions.hookRunner`). The spec already allows `@chimera/core` to not import the hook runner for other events; `AgentOptions.hookRunner` is an optional dependency only used for the stop-retry loop.

**Alternative considered:** Block at the server/event-bus level by suppressing `run_finished` and injecting a new `user_message`. Rejected: much more plumbing, introduces timing races with TUI clients, and creates an awkward contract where the server has to lie to the agent about whether the run finished.

### 2. Spec for the retry message

**Decision:** When stop is blocked, append a `assistant` role message to `this.session.messages` with content `"<reason>"`, and emit a `user_message` event on the queue so the TUI displays it.

**Rationale:**
- The model needs to see the rejection reason to know what to fix.
- Using an `assistant` role message (Claude's `additionalContext` pattern) or a `user` role message both work. A `user` message is simpler and closer to what Claude does (its `Stop` block adds a "system reminder").
- Emitting a `user_message` event preserves TUI scrollback display.

### 3. `HookFireResult` API changes

**Decision:** Extend `HookFireResult` with optional parsed fields rather than changing the return type.

```ts
export interface HookFireResult {
  blocked: boolean;
  blockingScript?: string;
  reason?: string;
  /** Parsed JSON from stdout on exit 0. Null if not valid JSON. */
  decision?: {
    decision?: 'block';
    reason?: string;
    additionalContext?: string;
    systemMessage?: string;
    suppressOutput?: boolean;
    continue?: boolean;
    hookSpecificOutput?: unknown;
  };
}
```

**Rationale:**
- `@chimera/permissions` and `@chimera/server` already use `HookFireResult`. Adding optional fields avoids a breaking API change across packages.
- The server bridge doesn't need to look at `decision` — it only cares about `blocked` for `PermissionRequest`.

### 4. Stop hook should fire only for `reason: "stop"`, not all run_finished

**Decision:** The `Stop` hook fires and can block only when `terminalReason === 'stop'`. Errors, interruptions, and max_steps do not invoke the hook and do not loop.

**Rationale:**
- If the agent hit an error or was interrupted, retrying doesn't make sense.
- If the agent hit `max_steps`, that's a safety cap exhaustion — trying again would just hit the same cap.
- Only clean "the model decided to stop" should be gate-able.

### 5. Should `run_finished` still be bridged for fire-and-forget observability?

**Decision:** Remove the `run_finished → Stop` mapping from the event-bus bridge.

**Rationale:**
- Same hooks would fire twice: once synchronously inside `runInternal`, once async from the bridge.
- The bridge's async fire-and-forget behavior would race with the next run turn, creating confusing state.
- Hooks that only cared about side effects on stop now get their side effect from the synchronous call (which still runs the scripts, just waits for completion).

## Risks / Trade-offs

- **Risk:** `@chimera/core` now has an optional dependency on `@chimera/hooks`. This slightly blurs the "hooks run in server" boundary spec.
  - Mitigation: `AgentOptions.hookRunner` is entirely optional. Without it, the agent behaves exactly as before. Only `Stop` uses it; all other hook events remain in the server. Document this in the spec.

- **Risk:** A hook that returns malformed JSON (looks like JSON but is actually a data format) could accidentally contain `"decision": "block"`.
  - Mitigation: This is extremely unlikely for typical hook scripts. The only real concern is old hooks that print JSON — we verified no existing repo has any. If needed, a future change could add a `CHIMERA_HOOKS_JSON_DECISIONS=1` opt-in env var.

- **Risk:** Stop-blocking hooks could create oscillation (agent writes code, hook rejects stop, agent deletes code, hook allows stop).
  - Mitigation: The 5-retry cap prevents infinite loops. In practice, LLMs are good at interpreting the rejection reason and fixing issues.

- **Risk:** Stop-retry messages increase token count and could push users over context window limits faster.
  - Mitigation: Each retry adds ~1-2 messages. With a 5-retry cap, this is bounded. Users can disable stop hooks by removing them from the directory.

## Migration Plan

No migration needed. This is fully backward compatible:
- Existing hooks that exit 0 with empty or non-JSON stdout: unchanged behavior
- Existing hooks that exit 2 on `PermissionRequest`: unchanged behavior
- New JSON-decision hooks work alongside old hooks in the same directory

## Open Questions

- Should we add a `CHIMERA_HOOKS_DISABLE_JSON` opt-out for users who run hooks that print JSON incidentally? (Not needed unless someone reports an issue.)
- Should `Stop` hooks also support `additionalContext` (adds a system reminder without blocking)? Easy to add as a follow-up since the JSON parser would already support it.
