## ADDED Requirements

### Requirement: TUI notification setting
`config.json` SHALL accept `tui.notifications` with the values `auto`, `bell` and `off`, and the interactive command SHALL pass it to the TUI. The default SHALL be `auto`.

#### Scenario: Setting passed to the TUI
- **WHEN** `config.json` has `"tui": { "notifications": "off" }`
- **THEN** the TUI sends no notifications
