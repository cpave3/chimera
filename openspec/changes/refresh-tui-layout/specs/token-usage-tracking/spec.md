## MODIFIED Requirements

### Requirement: TUI usage widget

The TUI SHALL render context use in the first footer row. It SHALL display a gauge with the share of the context window in use as a percentage, and the tokens used and the window size in human-readable form (`k`/`M` suffixes) as `<used>/<window>`. When `contextWindow` is not known it SHALL display the tokens used alone. It SHALL update on every `usage_updated` event the TUI receives.

The percentage SHALL be computed as `usedContextTokens / contextWindow * 100`, rounded to the nearest integer. The gauge and the percentage SHALL render in the theme's muted text color when the percentage is below 80, in an amber/warning color from 80 inclusive to 95 exclusive, and in a red/danger color at 95 or above. When the model was resolved via the unknown-model fallback path, the window size SHALL be followed by `?` to indicate the value is approximate.

When no `usage_updated` event has yet been received in the current TUI session (fresh, non-resumed), nothing SHALL be rendered for context use.

#### Scenario: Widget renders after first step

- **WHEN** a session has just received its first `usage_updated` with `usedContextTokens: 84000` and `contextWindow: 200000`
- **THEN** the footer SHALL show a gauge, `42%` and `84k/200k`

#### Scenario: Approximate window

- **WHEN** `usage_updated` carries `unknownWindow: true` and `contextWindow: 200000`
- **THEN** the footer SHALL show the window as `200k?`

#### Scenario: Widget hidden before first event

- **WHEN** a fresh session has started and no `usage_updated` has yet arrived
- **THEN** the footer SHALL show no context figures

#### Scenario: Color escalates near the limit

- **WHEN** `usedContextTokens / contextWindow` is `0.97`
- **THEN** the gauge and the percentage SHALL render in the theme's red/danger color
