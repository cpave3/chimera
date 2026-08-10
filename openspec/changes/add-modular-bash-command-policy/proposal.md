## Why

Host bash currently relies on four destructive regexes and broad target-level auto-approval, so commands can operate outside session read/write roots without risk classification or informed approval. Chimera needs a single conservative policy seam that preserves unattended routine work while escalating dangerous, unauthorized, or unresolved shell effects.

## What Changes

- Add an ordered, provider-neutral host-command policy pipeline in `@chimera/permissions`.
- Classify host bash risk through a pinned non-GPL adapter, initially `@aslamplr/pi-safe-shell@0.7.1`, normalized to safe/caution/danger/critical.
- Infer shell filesystem effects and authorize literal paths against canonical session read/write roots; unresolved semantics require approval.
- Make mandatory policy findings override `autoApprove` and remembered allow rules, while safe/caution in-scope commands remain eligible for normal automatic execution.
- Enrich permission events, lifecycle hooks, SDK/API contracts, and the TUI with structured findings and explanations.
- Add request-bound session directory grants and deny-with-feedback ordering.
- Queue concurrent TUI permission requests and preserve parent/subagent routing.
- Remove the parallel destructive-regex path and duplicate host bash gating after policy parity is tested.
- Add validated `commandPolicy.hostBash` configuration, enabled by default through caution.

## Capabilities

### New Capabilities
- `command-policy`: Ordered host-command analysis stages, normalized findings, effect/path authorization, and conservative failure behavior.

### Modified Capabilities
- `permissions`: Mandatory host bash policy precedence, enriched requests, grants, and feedback resolutions.
- `tool-execution`: Exactly-once policy and execution behavior for host foreground/background bash.
- `agent-core`: Structured permission events, concurrent pending requests, and ordered denial feedback injection.
- `agent-server`: Validated request-bound permission resolution actions.
- `agent-sdk`: Provider-neutral policy analysis and resolution transport.
- `lifecycle-hooks`: Structured policy findings in the existing pre-prompt hook.
- `tui`: Explained policy prompts, queueing, conditional grant actions, and deny feedback.
- `cli`: Shared validated command-policy configuration and provider construction.
- `subagents`: Inherited policy and correctly routed child approvals/feedback.

## Impact

This touches core permission/event types, `@chimera/permissions`, bash and local executor wiring, CLI configuration/factory construction, server/client schemas, hooks, TUI state/modal behavior, subagent routing, OpenSpec/user documentation, package manifests, and the lockfile. It adds pinned MIT dependencies for the approved classifier/parser. Static analysis remains an approval policy rather than host process confinement.
