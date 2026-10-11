## ADDED Requirements

### Requirement: TUI layout option
The interactive command SHALL accept `--inline` to use the inline layout. The config file SHALL accept `tui.layout` with the values `fullscreen` and `inline`, and `tui.mouse` as a boolean. The flag SHALL take precedence over the config file. The default layout SHALL be `fullscreen` and the default for `tui.mouse` SHALL be `true`.

#### Scenario: Config
- **WHEN** the config file sets `tui.layout` to `inline` and no flag is given
- **THEN** the TUI uses the inline layout

#### Scenario: Flag over config
- **WHEN** the config file sets `tui.layout` to `fullscreen` and the user passes `--inline`
- **THEN** the TUI uses the inline layout

#### Scenario: Invalid value
- **WHEN** the config file sets `tui.layout` to `wide`
- **THEN** the command exits with an error that names `tui.layout`

### Requirement: Exit summary
When a fullscreen session ends, the interactive command SHALL print the session id and the command that resumes the session.

#### Scenario: Exit
- **WHEN** the user leaves a fullscreen session with id `01ABCDEFGH8AWWBRGC`
- **THEN** the terminal shows the session id and `chimera --session 01ABCDEFGH8AWWBRGC`
