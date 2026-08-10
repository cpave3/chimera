## Context

Host bash is an opaque `sh -c` string. The tool has four hard-coded refusals, while the permission gate can auto-approve all host execution before hooks/rules and can be traversed twice. Direct file tools enforce canonical read/write roots, but bash operands do not. Existing agent permission suspension, hooks, API transport, TUI modal, runtime path mutation, and mid-run message injection are reusable.

The approved policy uses a non-GPL classifier, promptable critical commands, caution as the default auto-allow threshold, host-only analysis, session-only grants, and deny feedback delivered to the continuing run.

## Goals / Non-Goals

**Goals:**

- Analyze each agent-issued host bash command exactly once through replaceable stages.
- Require positive proof of acceptable risk and authorized filesystem effects for unattended execution.
- Reuse one provider-neutral permission contract from core through hooks/API/TUI.
- Preserve denial-result-before-feedback ordering and exact request association.

**Non-Goals:**

- Static resolution of arbitrary runtime shell behavior.
- OS-level confinement of approved host commands.
- Sandbox-target classification, persistent directory grants, or non-bash policy in this release.

## Decisions

### Ordered provider-neutral pipeline

`@chimera/permissions` owns a `CommandPolicyPipeline` composed from stages with stable IDs. Stages consume `CommandPolicyContext` and validated provider-neutral facts from prior stages and return `pass`, `findings`, or `error`. They never prompt, execute, mutate grants, or apply permission rules. Stage errors become mandatory `analyzer_error` findings.

This decouples the permission mechanism from the initial risk library and lets later stages consume normalized shell operations rather than provider types.

### Pinned MIT risk adapter

The first risk stage wraps `@aslamplr/pi-safe-shell@0.7.1`, selected in Legato approval. A spike must prove its internal analyzer can be imported, initialized, bundled by tsup, and run under Node 20. The adapter normalizes only `safe`, `caution`, `danger`, `critical`, score, and explanatory evidence. A failed spike blocks implementation rather than falling back to regexes.

### Independent effects and authorization

A Chimera-owned Bash AST effect registry emits normalized `read`, `write`, and `delete` operands for known commands and redirects. Unsupported executables/flags and dynamic constructs emit `unresolved`. A separate authorization stage resolves operands against the tracked cwd and immutable root snapshot, canonicalizing existing targets or the nearest existing ancestor for new writes.

The separation prevents a risk score from being mistaken for filesystem authorization.

### Mandatory policy precedes legacy approval

Host bash invokes the pipeline before `autoApprove` or command rules. Risk above the configured threshold, unauthorized path, unresolved semantics, or analyzer failure cannot be suppressed by `host`, `all`, or an existing allow rule. A passing command then follows legacy policy, so `autoApprove: none` still intentionally prompts.

### Bash owns one gate call

The bash tool explicitly gates every host foreground/background invocation against a raw local executor. `GatedExecutor` remains for internal subprocess-backed tools but does not wrap the bash execution path. The `all` construction bypass and destructive regex path are removed after parity tests.

### Request-bound grant and feedback actions

Permission resolution accepts ordinary allow/deny, allow plus the exact pending grant proposal, or deny plus non-empty feedback. Grant mutation is validated and persisted before allow resolves. Denial feedback is queued atomically with resolution, so the denied tool result enters history before feedback drains at the next clean step boundary. Accepted feedback survives interruption until a later continuation.

### Concurrent TUI queue

The TUI stores a FIFO of `(sessionId, requestId)` items rather than one pending modal. This preserves concurrent and subagent requests without changing core's request map.

## Risks / Trade-offs

- **Unstable provider API** → Pin exactly, isolate the adapter, and gate work on import/build/corpus tests.
- **Static false negatives** → Independent allow-by-proof effects/path stages; unknown prompts.
- **False positives** → Start with a bounded known-command registry and a measured corpus.
- **TOCTOU/approved escape** → Clearly state analysis is not confinement; sandbox remains enforcement.
- **Prompt volume** → Default through caution, then grow registry only with tests.
- **Sensitive logging** → Do not include full command/path details in normal debug telemetry.

## Migration Plan

1. Add additive provider-neutral contracts and pipeline behind `commandPolicy.hostBash`.
2. Ship enabled by default through caution after provider/build/security corpus passes.
3. Retain explicit `enabled: false` legacy rollback for one release; never disable automatically on analyzer failure.
4. Existing allow rules continue for ordinary prompts but cannot override mandatory findings.

## Open Questions

None. Product and provider decisions were resolved through Legato plan approval.
