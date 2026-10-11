## ADDED Requirements

### Requirement: Surface tokens
The theme SHALL have a `surface` group with the optional colours `panel`, `raised`, `sunken` and `border`, and the `text` group SHALL have an optional `dim` colour. A user theme MAY set them. A layout SHALL draw a surface without a fill when its colour is not set.

#### Scenario: User override
- **WHEN** `theme.json` sets `surface.panel` to `#101010`
- **THEN** the context panel is filled with `#101010`

#### Scenario: Plain theme
- **WHEN** `NO_COLOR` is set
- **THEN** no surface is filled and the context panel is separated by a border line

### Requirement: Fullscreen default palette
The fullscreen layout SHALL use a default palette of explicit colours that includes a background, and SHALL fill the screen with that background. The inline layout SHALL keep the ANSI default palette and SHALL NOT fill a background.

#### Scenario: Fullscreen
- **WHEN** the TUI starts in the fullscreen layout with no user theme
- **THEN** the screen background is `#1f1d27` and the accent colour is `#b79cf7`

#### Scenario: Inline
- **WHEN** the TUI starts in the inline layout with no user theme
- **THEN** the accent colours are ANSI colour names and no background is drawn
