## MODIFIED Requirements

### Requirement: GatedExecutor
`@chimera/permissions` SHALL provide a `GatedExecutor` class that implements the `Executor` interface and wraps an inner `Executor`. Each internal `exec()` call SHALL be routed through `PermissionGate.request(req)`. Agent-issued host bash SHALL instead call the same gate explicitly once before using an unwrapped host executor, preventing duplicate evaluation. File operations SHALL pass through unchanged.

For host bash, `DefaultPermissionGate.request(req)` SHALL apply this sequence:

1. Run the configured mandatory command-policy pipeline.
2. If mandatory findings exist, skip broad auto-approve and existing allow rules, fire the enriched `PermissionRequest` hook, then headless-deny or raise the user request.
3. If no mandatory finding exists, consult `AutoApproveLevel`, then matching rules.
4. If still unresolved, fire the hook, headless-deny when configured, or raise the user request.
5. Execute the exact command once only after allow.

Existing deny rules SHALL remain effective. Existing allow rules SHALL NOT suppress risk-above-threshold, unauthorized-path, unresolved, or analyzer-error findings.

#### Scenario: Broad auto-approve cannot bypass policy
- **WHEN** `autoApprove` is `host` or `all` and host bash has a mandatory finding
- **THEN** the command SHALL await approval or be denied headlessly without execution

#### Scenario: Passing command follows legacy policy
- **WHEN** host bash has no mandatory finding and `autoApprove` permits host execution
- **THEN** the command SHALL execute without a permission prompt

### Requirement: PermissionGate public surface
`PermissionGate.request(req)` SHALL accept an optional provider-neutral command-policy context/result for host bash. `PermissionRequest` SHALL carry `{ requestId, tool, target: "host", command, cwd, reason? }` and optional structured `policyAnalysis` including ordered stage summaries, normalized findings, and a request-bound grant proposal.

Permission resolution SHALL support allow once, deny once, deny with non-empty feedback, and allow once with the exact pending session grant proposal. Mandatory findings SHALL NOT be remembered as allow overrides.

#### Scenario: Request-bound grant
- **WHEN** a user selects allow with the exact still-valid grant proposal
- **THEN** the session path SHALL be persisted before the pending command resolves as allowed

#### Scenario: Deny with feedback
- **WHEN** a user denies a pending command with non-empty feedback
- **THEN** the command SHALL return a denial and the feedback SHALL reach the same run after that tool result and before the next model step
