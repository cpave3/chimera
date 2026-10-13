## ADDED Requirements

### Requirement: Path findings in the OS sandbox
For a host command that will run in the OS sandbox, the permission gate SHALL NOT ask for approval because of path findings. Elevation, risk, blocked and analyzer-error findings SHALL act as they do without the sandbox. A command approved with a sudo finding SHALL run outside the sandbox.

#### Scenario: Path finding only
- **WHEN** a sandboxed command has one finding, a write outside the authorized directories
- **THEN** the command runs with no prompt, inside the sandbox

#### Scenario: Risk finding
- **WHEN** a sandboxed command has a `danger` risk finding
- **THEN** the user is asked, as without the sandbox

### Requirement: Approval of an unsandboxed run
A request to run a command outside the OS sandbox SHALL be approval-required unless an explicit matching allow rule has `allowUnsandboxed: true` and `patternKind: "exact"` or `"prefix"`. The auto-approve level, ordinary allow rules, glob rules and AI approval reviewer SHALL NOT grant a bypass. A bypass rule SHALL resolve only the elevation finding with stage `os_sandbox` and rule id `unsandboxed`; other mandatory findings SHALL still require approval and hard blocks SHALL still deny. A matching deny rule SHALL win. Without a matching bypass rule, the gate SHALL ask the user and show the model's reason, or deny in a headless session. The decision SHALL be written to the decision audit log.

#### Scenario: Allow rule does not apply
- **WHEN** an ordinary allow rule matches the command and the request is for an unsandboxed run
- **THEN** the user is asked

#### Scenario: Headless
- **WHEN** the session auto-denies prompts and no explicit bypass rule matches an unsandboxed run
- **THEN** the request is denied

#### Scenario: Explicit bypass in headless mode
- **WHEN** an exact or prefix allow rule with `allowUnsandboxed: true` matches an unsandboxed request whose only mandatory finding is `os_sandbox`, in a headless session
- **THEN** the gate admits the command without prompting

#### Scenario: Other mandatory findings remain
- **WHEN** an explicit bypass rule matches but the command has a sudo, risk, path or other mandatory finding
- **THEN** the finding still requires approval

#### Scenario: Deny wins over bypass
- **WHEN** both an explicit bypass allow rule and a deny rule match
- **THEN** the gate denies the request without a prompt

### Requirement: Literal command prefix rules
`PermissionRule.patternKind` SHALL support `exact`, `glob` and `prefix`. Prefix matching SHALL compare literal tokens from the shell AST of both the pattern and command, and SHALL admit only a single simple command. Compounds, pipelines, substitutions, redirects, execution wrappers, environment assignments and unsupported syntax SHALL NOT match. A prefix grant SHALL trust the executable and its subcommands, not confine their behavior.

#### Scenario: Literal arguments after prefix
- **WHEN** the prefix is `pnpm build` and the command is `pnpm build --filter server`
- **THEN** the prefix matches

#### Scenario: Compound requires fresh approval
- **WHEN** a bypass prefix is `pnpm build` and the unsandboxed command is `pnpm build && git push`
- **THEN** the prefix does not match and the command needs fresh approval

### Requirement: Bypass rule API and remembering
The server rule API SHALL retain optional boolean `allowUnsandboxed` and all three pattern kinds when adding, persisting and listing rules. Permission resolution SHALL accept `remember` with scope `session`, `project` or `global`, required `pattern` and `patternKind`, and optional `allowUnsandboxed`. It SHALL reject missing or partial pattern specifications for every scope.

#### Scenario: Persist and list a prefix bypass
- **WHEN** a client adds a global prefix allow rule with `allowUnsandboxed: true`
- **THEN** the persisted and listed rule retains both the prefix kind and bypass flag

#### Scenario: Remember a scoped bypass via HTTP
- **WHEN** a client resolves a pending unsandboxed request with an allow decision and a session, project or global prefix bypass remember scope
- **THEN** the remembered rule retains the supplied pattern, pattern kind and bypass flag, and project/global rules persist at their respective scope
