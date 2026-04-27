# permissions Specification

## Purpose

The `@chimera/permissions` package provides the auto-approve tier system, the `GatedExecutor` that gates tool calls, the rule matching algorithm, and rule scopes (session / project) with atomic persistence. It is the single place where a tool call can be denied or auto-approved.

## Requirements

### Requirement: Auto-approve tiers

`@chimera/permissions` SHALL define an `AutoApproveLevel` in `{"none","sandbox","host","all"}` with these behaviors:

- `none` — every host-target tool call triggers a permission prompt.
- `sandbox` — sandbox-target calls are auto-approved, host-target calls prompt. (In MVP, sandbox mode is always off so this level reduces to `none` in practice.)
- `host` — host-target calls are auto-approved.
- `all` — every call auto-approved.

When `--sandbox` is not set (always, in MVP), the CLI default SHALL be `host`. The default SHALL NOT be read from the config file in MVP — it is established by the CLI based on whether sandboxing is active.

#### Scenario: Default level without sandbox

- **WHEN** a user runs `chimera` without passing `--sandbox` and without `--auto-approve`
- **THEN** the effective `AutoApproveLevel` SHALL be `"host"` and bash tool calls SHALL execute without prompting

#### Scenario: Explicit `--auto-approve none`

- **WHEN** a user runs `chimera --auto-approve none` and the model issues a bash tool call
- **THEN** a `permission_request` event SHALL be emitted and the tool SHALL NOT execute until `resolvePermission` is called

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

### Requirement: Rule matching

Rules SHALL have shape `{ tool, target, pattern, patternKind: "exact"|"glob", decision: "allow"|"deny", createdAt }`. Matching SHALL compare `tool` and `target` for equality; `pattern` SHALL be compared to the full command string using string equality (for `"exact"`) or `minimatch` (for `"glob"`). No regex is supported in MVP.

When multiple rules match a request, selection SHALL apply these tie-breakers in order: (1) any `deny` wins over any `allow`; (2) among rules of the same decision, the rule with the longer `pattern` wins; (3) among otherwise-equal rules, the most recently added wins.

#### Scenario: Longer pattern wins

- **WHEN** both `{ pattern: "git *", decision: "allow" }` and `{ pattern: "git push *", decision: "deny" }` are in the store and the model issues `bash { command: "git push origin main" }`
- **THEN** the deny rule SHALL be selected (deny-wins by tier 1; and also longer-wins by tier 2)

### Requirement: Rule scopes and persistence

`@chimera/permissions` SHALL support exactly two scopes in MVP:

- **Session** — rules live in process memory only and are discarded when the `PermissionGate` is disposed.
- **Project** — rules persist to `./.chimera/permissions.json` relative to the session's `cwd`. The file SHALL have shape `{ version: 1, rules: PermissionRule[] }`. On the first rule added in the project scope, the file and its parent directory SHALL be created; subsequent additions rewrite the file atomically (write-to-temp + rename).

User scope (`~/.chimera/permissions.json`) is deferred.

#### Scenario: First project rule creates the file

- **WHEN** the CWD has no `.chimera/` directory and the consumer calls `gate.addRule(rule, "project")`
- **THEN** `.chimera/permissions.json` SHALL exist afterwards with `{ version: 1, rules: [rule] }` and the parent `.chimera/` directory SHALL exist

#### Scenario: Session rules don't touch disk

- **WHEN** the consumer adds a rule with scope `"session"` and the agent then exits cleanly
- **THEN** no file under `.chimera/` SHALL be created or modified as a result of that rule

### Requirement: PermissionGate public surface

`PermissionGate` SHALL expose:

- `request(req: PermissionRequest): Promise<PermissionResolution>` — raises a `permission_request` event via the core, resolves when `resolvePermission` is called.
- `addRule(rule: PermissionRule, persist: "session" | "project"): void` — stores a rule in the requested scope.
- `check(req: PermissionRequest): PermissionResolution | null` — returns the resolution implied by the current rules, or `null` if no rule matches.

`PermissionRequest` SHALL carry at minimum `{ requestId, tool, target: "host", command, cwd, reason? }`.

#### Scenario: `check` with no matching rules

- **WHEN** no rule matches the incoming request
- **THEN** `check` SHALL return `null` and SHALL NOT mutate rule storage
