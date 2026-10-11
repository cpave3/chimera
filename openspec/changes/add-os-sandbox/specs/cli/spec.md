## ADDED Requirements

### Requirement: OS sandbox settings
`commandPolicy.hostBash` SHALL accept `osSandbox` (`off`, `auto` or `required`; default `auto`), `network` (`on` or `off`; default `on`) and `sandboxWritePaths` (a list of directories). With `auto`, the CLI SHALL use the OS sandbox when it is available and SHALL warn once when it is not. With `required` and no OS sandbox available, every host command SHALL be refused with a message that names the setting. With `off`, host commands SHALL run as they did before.

#### Scenario: Auto without a sandbox
- **WHEN** `osSandbox` is `auto` and no OS sandbox is available
- **THEN** one warning is shown and host commands run unsandboxed

#### Scenario: Required without a sandbox
- **WHEN** `osSandbox` is `required` and no OS sandbox is available
- **THEN** a host command does not run, and the result names `commandPolicy.hostBash.osSandbox`

#### Scenario: Off
- **WHEN** `osSandbox` is `off`
- **THEN** host commands run without the OS sandbox

### Requirement: Sandbox state in the TUI
When the session's host commands run in the OS sandbox, the TUI SHALL show `os` as the sandbox, in the context panel and in the inline layout's banner and footer. A Docker sandbox mode SHALL keep its own name.

#### Scenario: OS sandbox active
- **WHEN** the interactive session starts with the OS sandbox active and no Docker sandbox
- **THEN** the context panel shows `sandbox os`
