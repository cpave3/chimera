# tui-theme-system Specification

## Purpose

The TUI theme system provides semantic color tokens, a React context provider,
and config-file loading from `~/.chimera/theme.json` so users can customize
the terminal UI's colors. Components consume tokens via `useTheme()` rather
than hardcoded ANSI colors, so themes can be swapped without per-component
changes.

## Requirements

### Requirement: Theme tokens are defined with semantic names
The system SHALL provide a set of color tokens with semantic names that describe their purpose rather than their literal color value.

#### Scenario: Token structure includes expected groups
- **WHEN** the theme system is initialized
- **THEN** tokens SHALL be organized into base, accent, status, and text groups

#### Scenario: Default theme provides all tokens
- **WHEN** the default theme is loaded
- **THEN** it SHALL include at minimum: primary, secondary, success, warning, error, muted, background, foreground

### Requirement: Theme provider makes tokens available to components
The system SHALL provide a React context provider that supplies theme tokens to descendant components.

#### Scenario: Components can access theme via hook
- **WHEN** a component calls `useTheme()`
- **THEN** it SHALL receive the current theme object containing all color tokens

#### Scenario: Theme provider wraps TUI root
- **WHEN** the TUI application renders
- **THEN** all components SHALL be children of the theme provider

### Requirement: User themes are loaded from config files
The system SHALL load user-defined themes from configuration files and merge them with defaults.

#### Scenario: Theme loads from default config path
- **WHEN** the TUI starts without a custom theme path
- **THEN** it SHALL look for theme configuration at `~/.chimera/theme.json` (alongside `sessions/`, `config.json`, `logs/`, and `instances/`).

#### Scenario: User theme deep-merges with defaults
- **WHEN** a user theme defines a subset of tokens
- **THEN** undefined tokens SHALL fall back to default values

#### Scenario: Missing config uses defaults
- **WHEN** no user theme file exists
- **THEN** the system SHALL use the default theme without error

### Requirement: Components use theme tokens instead of hardcoded colors
The system SHALL refactor TUI components to use theme tokens for all color styling.

#### Scenario: Text colors use theme tokens
- **WHEN** a component renders text
- **THEN** it SHALL use `text.primary`, `text.secondary`, or `text.muted` instead of direct ANSI colors

#### Scenario: Status colors use theme tokens
- **WHEN** a component displays status (success, error, warning)
- **THEN** it SHALL use `status.success`, `status.error`, or `status.warning` tokens

#### Scenario: Interactive elements use accent tokens
- **WHEN** a component renders interactive elements
- **THEN** it SHALL use `accent.primary` or `accent.secondary` for highlighting
