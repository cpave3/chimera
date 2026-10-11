## ADDED Requirements

### Requirement: Cached share in the TUI usage widget
The TUI usage widget SHALL show the share of the last prompt that the provider served from its cache, as `cache N%`, when the last step reported input tokens and at least one cached input token.

#### Scenario: Cached prompt
- **WHEN** the last step reports 10,000 input tokens of which 8,000 were cached
- **THEN** the widget shows `cache 80%`

#### Scenario: No cached tokens
- **WHEN** the last step reports no cached input tokens
- **THEN** the widget shows no cache figure
