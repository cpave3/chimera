# permissions Specification (delta)

## MODIFIED Requirements

### Requirement: GatedExecutor

`@chimera/permissions` SHALL provide a `GatedExecutor` class that implements the `Executor` interface and wraps an inner `Executor`. Each `exec()` call SHALL be routed through `PermissionGate.request(req)`, which applies the gate's full decision sequence. `readFile`, `writeFile`, and `stat` SHALL pass through without gating — only `exec()` has a permission surface in MVP.

`DefaultPermissionGate.request(req)` SHALL apply the following sequence in order:

1. Consult the configured `AutoApproveLevel`; auto-approve if the level permits.
2. Otherwise, consult the rule store via `PermissionGate.check(req)` — if a rule matches, honor it without prompting and return `{ decision, remembered: true }`.
3. Otherwise, if a `hookRunner` is configured, fire the `PermissionRequest` lifecycle hook (see `lifecycle-hooks` spec). If any hook for this firing exits with code 2, the gate SHALL return `{ decision: "deny", remembered: false }` without raising the user prompt; the underlying tool result delivered to the model SHALL be `{ error: "denied by hook" }`, distinguishable from `{ error: "denied by user" }` and `{ error: "denied by rule" }`. If no hook blocks (all exit 0, time out, or fail), the gate SHALL proceed to step 4.
4. If `headlessAutoDeny` is set and the target is `host`, return `{ decision: "deny", remembered: false }` (existing behavior preserved).
5. Otherwise call the configured `raiseRequest` callback to suspend for user resolution.

`DefaultPermissionGate` SHALL accept an optional `hookRunner` constructor parameter (an interface that fires lifecycle hooks). When `hookRunner` is not provided (e.g., in unit tests), step 3 SHALL be skipped and the gate SHALL behave as if no `PermissionRequest` hook were installed.

#### Scenario: Matching allow rule bypasses prompt

- **WHEN** the project-scope rule store contains `{ tool: "bash", target: "host", pattern: "pnpm run test:*", patternKind: "glob", decision: "allow" }` and the model issues `bash { command: "pnpm run test:unit", target: "host" }` under `--auto-approve none`
- **THEN** the call SHALL execute without emitting `permission_request` and SHALL emit `permission_resolved` with `decision: "allow"`, `remembered: true`

#### Scenario: Deny rule beats allow rule

- **WHEN** two rules both match a command — one `allow`, one `deny` — regardless of insertion order
- **THEN** the deny rule SHALL win and the tool SHALL return `{ error: "denied by rule" }` to the model

#### Scenario: PermissionRequest hook blocks before user prompt

- **WHEN** the gate reaches step 3 (no rule matches, auto-approve does not apply) and an installed `PermissionRequest` hook exits with code 2
- **THEN** the user SHALL NOT see a permission prompt, the tool result delivered to the model SHALL be `{ error: "denied by hook" }`, and a `permission_resolved` event SHALL fire with `decision: "deny"` and `remembered: false`

#### Scenario: PermissionRequest hook allows; user prompt proceeds

- **WHEN** the gate reaches step 3 and the only installed `PermissionRequest` hook exits 0
- **THEN** step 4 SHALL run normally: a `permission_request` event SHALL be emitted and the gate SHALL suspend until `resolvePermission` is called

#### Scenario: GatedExecutor without hookRunner

- **WHEN** a `GatedExecutor` is constructed without a `hookRunner` and reaches step 3
- **THEN** step 3 SHALL be skipped silently and the gate SHALL proceed directly to step 4
