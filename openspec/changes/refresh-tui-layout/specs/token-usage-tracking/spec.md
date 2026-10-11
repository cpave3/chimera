## MODIFIED Requirements

### Requirement: TUI usage widget

The TUI SHALL render a usage widget in the status row. The widget SHALL display the share of the context window in use as `ctx N%` when `contextWindow` is known, and the tokens used in human-readable form (`k`/`M` suffixes) as `ctx <used>` when it is not. It SHALL update on every `usage_updated` event the TUI receives.

The percentage SHALL be computed as `usedContextTokens / contextWindow * 100`, rounded to the nearest integer. The widget SHALL render in the theme's default text color when the percentage is below 80, in an amber/warning color from 80 inclusive to 95 exclusive, and in a red/danger color at 95 or above. When the model was resolved via the unknown-model fallback path, the widget SHALL render a `?` after the percentage to indicate the window size is approximate.

When no `usage_updated` event has yet been received in the current TUI session (fresh, non-resumed), the widget SHALL render nothing so the row is not cluttered before any step finishes.

#### Scenario: Widget renders after first step

- **WHEN** a session has just received its first `usage_updated` with `usedContextTokens: 41200` and `contextWindow: 200000`
- **THEN** the widget SHALL render `ctx 21%` in the status row

#### Scenario: Approximate window

- **WHEN** `usage_updated` carries `unknownWindow: true`, `usedContextTokens: 64000` and `contextWindow: 128000`
- **THEN** the widget SHALL render `ctx 50%?`

#### Scenario: Widget hidden before first event

- **WHEN** a fresh session has started and no `usage_updated` has yet arrived
- **THEN** the widget SHALL render no visible output and SHALL NOT occupy a separator in the status row

#### Scenario: Color escalates near the limit

- **WHEN** `usedContextTokens / contextWindow` is `0.97`
- **THEN** the widget SHALL render in the theme's red/danger color
