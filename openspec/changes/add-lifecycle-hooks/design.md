## Context

Chimera currently has no way for external tools to observe or react to its lifecycle. The proximate driver is Legato (kanban-style task tracker), which today integrates with Claude Code by writing five shell scripts into `.claude/hooks/` and merging matching entries into `.claude/settings.json`. The scripts call back into the `legato` CLI to flip a task card's activity state between *working* / *waiting* / *idle*. Legato also has its own hook subsystem for Staccato that uses a much simpler model: drop an executable into `~/.config/staccato/hooks/<event>/`, no config edits.

Two reference implementations were considered:

- **Claude Code** (`settings.json`-driven, four hook types, ~27 events, JSON-on-stdin, exit-code blocking, `disableAllHooks` / `allowManagedHooksOnly` policy knobs).
- **Staccato** (`pkg/hooks/hooks.go`, ~200 LOC) — directory-driven, single hook type, JSON-on-stdin + env vars, exit-code 2 = block on `pre-*` / warn on `post-*`, 30s timeout.

The user explicitly chose the simpler Staccato shape ("this is too complex; I just want one hook model for now"). Existing Chimera invariants of note:

- `agent-core/spec.md:97`: `@chimera/core` SHALL NOT expose a "second channel (callbacks, direct Session mutation observation, hooks) for the same state changes." Any hook subsystem must therefore live outside `@chimera/core` and be a *consumer* of the existing `AgentEvent` stream, not a parallel observation channel.
- `permissions` already owns the only blocking decision point (the `GatedExecutor`). Pre-event hook blocking has to integrate there.
- The TUI is a separate process from the server; hooks must run server-side or the model `chimera attach` breaks.

## Goals / Non-Goals

**Goals:**

- Legato can integrate with Chimera by dropping five shell scripts into `~/.chimera/hooks/<EventName>/` (or `.chimera/hooks/<EventName>/`), with no edits to any settings file.
- A pre-event hook (`PermissionRequest`) can block a tool call by exiting 2 — distinct from existing rule-based and user-driven denials.
- Hook execution failures never abort the session; pre-events fail open, post-events fail soft.
- Discovery is dynamic: drop a script, it picks up on next firing without a restart.
- The `agent-core` invariant that `AgentEvent`s are the sole observable surface remains intact.

**Non-Goals:**

- No matchers (e.g., `Bash(git *)`). Every script in an event directory runs for every firing.
- No `http` / `prompt` / `agent` hook types. Only executables.
- No `settings.json`-declared hooks. Directory drop-in is the only registration path.
- No managed-policy lockdown (`disableAllHooks`, `allowManagedHooksOnly`). If demand emerges, that's a follow-on change.
- No plugin system, no in-process callback API, no JS hooks.
- No mid-session hot-reload of hook directories beyond "the directory is re-listed at each firing."
- No new lifecycle events beyond the five Legato needs. Adding events later is its own change.

## Decisions

### D1: Staccato-style directory discovery, not Claude Code's `settings.json` model

**Decision:** Hooks live as executable files in `~/.chimera/hooks/<EventName>/` (global) and `<cwd>/.chimera/hooks/<EventName>/` (project). Presence + execute bit is the only registration mechanism.

**Rationale:**
- Implementation cost is ~200 LOC vs. Claude Code's much larger hook system. The user explicitly asked for the simplest viable model.
- Legato's existing `StaccatoAdapter` already speaks this dialect; a Chimera adapter is a near-clone with `staccato` swapped for `chimera`. No `settings.json` merge code, which means no class of "Legato corrupted my settings file on uninstall" bugs.
- `chimera hooks list` against a real filesystem is a trivial command. The same operation against a `settings.json` model requires a JSON parse + schema validate.

**Alternatives considered:**
- Claude Code's `settings.json` model: rejected as overkill for the stated scope. Rich metadata (matchers, timeouts per hook, hook types) costs implementation complexity we don't need yet.
- Hybrid (directory for `command`, JSON for `http`/`prompt`/`agent`): rejected because we're not introducing the non-`command` types in this change. With only one hook type, the JSON config has nothing to add.

### D2: Hook runner lives in `@chimera/server`, not `@chimera/core`

**Decision:** The hook runner is a server-package concern. It subscribes to the agent's `AgentEvent` stream, translates events into hook firings, and runs scripts. `@chimera/core` neither imports nor knows about hooks.

**Rationale:**
- Honors the existing `agent-core` invariant that `AgentEvent`s are the sole observable surface from `@chimera/core`. The hook runner is a downstream consumer, not a parallel channel.
- Keeps the `chimera attach` model working: the TUI never spawns hook scripts; only the server does. This is correct on Unix where the TUI may be on a different host entirely.
- Avoids forcing every `@chimera/core` test to mock a hook runner.

**Alternatives considered:**
- Hook runner inside `@chimera/core`: would conflict with the agent-core spec wording ("...callbacks, direct Session mutation observation, hooks...") and would couple the agent loop to filesystem I/O.

### D3: `PermissionRequest` is fired by `GatedExecutor`, not by event-stream observation

**Decision:** Four of the five events (`UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`) are fired by the server observing the `AgentEvent` stream. `PermissionRequest` is fired by `GatedExecutor` itself, before it emits the `permission_request` event.

**Rationale:**
- `PermissionRequest` must be able to block (exit 2 → "denied by hook"). Blocking from a downstream event-stream observer is racy: by the time the observer sees `permission_request`, the gate has already suspended the loop and emitted the event to UIs.
- Putting the call in `GatedExecutor` means the hook is consulted in the same control-flow position a UI prompt would occupy. The "denied by hook" outcome is symmetric with "denied by rule" and "denied by user".

**Alternatives considered:**
- Make all five events purely observational and accept that hooks can only observe permission requests, not block: this would meet Legato's needs but precludes the obvious next use case (project-local "block any `rm -rf`" guard). Cheap to support correctly now; expensive to retrofit later.

### D4: Fail-open semantics for pre-events; fail-soft for post-events

**Decision:** A `PermissionRequest` hook that crashes, hangs (timeout), or exits with a non-zero, non-2 status is treated as "allow" with a warning logged. Post-event hooks (everything else) treat any non-zero exit as a logged warning that does not affect the session.

**Rationale:**
- Fail-closed on pre-events would mean a buggy or absent interpreter can wedge the agent. The cost of a buggy hook denying every tool call is far worse than the cost of one missed denial.
- The user can re-add a stricter policy in their own hook by exiting 2 explicitly on any internal error.

**Alternatives considered:**
- Fail-closed on pre-events: rejected for the wedging risk above.
- Treating any non-zero as a block: rejected because exit codes 1, 127, etc. are common from misconfigured scripts; conflating them with "policy denial" loses the distinction Claude Code preserves with code 2.

### D5: 30-second timeout, per-script

**Decision:** Each hook process is killed if it has not exited 30 seconds after spawn. Timeout treatment matches D4 (fail-open on pre, fail-soft on post).

**Rationale:**
- Matches Staccato's chosen value, which has held up in practice.
- Long enough that a hook making a network call (e.g., posting to a remote audit service) usually fits; short enough that a hung hook doesn't visibly wedge a session.
- Per-script (not per-firing) so installing a second hook never silently shortens an existing one's budget.

### D6: Event re-discovery on every firing, not cached

**Decision:** Each event firing re-lists the two directories. No in-memory cache, no inotify/fsevents.

**Rationale:**
- The cost is one `readdir` per event per firing. At expected scale (a handful of events per second peak, a handful of files per directory), this is below noise.
- A cache means dealing with invalidation, "I dropped a script and it didn't pick up" support questions, and a divergence between `chimera hooks list` (which is going to re-list anyway) and runtime behavior.

### D7: Stdin payload mirrors Claude Code's shape; env vars use `CHIMERA_*` prefix

**Decision:** The JSON payload field names (`event`, `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_response`, etc.) follow Claude Code's conventions where they overlap. Env vars use the `CHIMERA_` prefix.

**Rationale:**
- Legato (and any future portable hook) can share parsing logic across both targets; if a hook is written defensively (`event === 'PostToolUse'` rather than `event === 'post-tool-use'`), it works for either Claude Code or Chimera with no branching.
- The `LEGATO_TASK_ID` env var (and any other parent-injected vars) pass through transparently because hooks inherit the parent process's environment.

## Risks / Trade-offs

- **Risk**: any executable in two well-known directories runs with the agent's privileges. → **Mitigation**: document this clearly in the user-facing docs; keep the directory paths well-known and small in number; treat this as the same trust model Staccato and git hooks already establish. A `disableAllHooks` knob and managed-policy lockdown can be added in a follow-on change if a deployment scenario requires it; not worth implementing speculatively.
- **Risk**: a hook that always exits 2 wedges any tool that needs permission. → **Mitigation**: this is the user's stated intent if they install such a hook. The fail-open semantics on *crashes/timeouts* (D4) ensure this only happens on intentional `exit 2`, which is the documented block signal.
- **Risk**: `GatedExecutor` test fixtures gain a new dependency. → **Mitigation**: the `hookRunner` parameter is optional (per the modified `permissions` spec); when absent, the gate behaves as if no `PermissionRequest` hook were installed. Existing tests do not need to change.
- **Risk**: `SessionEnd` is fired from server-side session disposal, but the server's session lifecycle is currently informal. → **Mitigation**: define a single `disposeSession(sessionId)` codepath in the server that fires `SessionEnd` and handles cleanup; treat any future session-disposal trigger (process shutdown, idle timeout) as routing through that one function.
- **Trade-off**: choosing one hook type now (`command` only) means a future need for `http` or `prompt` hooks requires extending discovery (e.g., introducing a `<EventName>/<name>.json` sidecar or a `settings.json` entry path). Re-evaluating this is cheap because we have not committed to the directory layout being the only registration mechanism forever — only that it is the only one in this change.
- **Trade-off**: skipping managed-policy / `disableAllHooks` means this change is not safe to land in environments where users cannot be trusted with their own hook directories. That is consistent with the rest of Chimera's MVP-era trust model (e.g., `--auto-approve host` defaults to executing host bash without prompting), so this does not introduce a new mismatch.

## Open Questions

- **None blocking implementation.** The directory paths, event names, payload schema, exit-code semantics, and timeout are all settled by this design. If `chimera hooks list` should accept event-name filtering (e.g., `chimera hooks list PostToolUse`), that is purely a polish decision and can be deferred until a user asks for it.
