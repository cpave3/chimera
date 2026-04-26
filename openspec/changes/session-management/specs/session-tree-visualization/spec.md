## ADDED Requirements

### Requirement: Tree representation is shared across picker and printout

The session tree visualization SHALL use one canonical layout — sessions ordered by root `createdAt` (descending), with each root's descendants inlined immediately beneath it, indented by depth using ASCII branch glyphs (`├──`, `└──`, `│  `).

The interactive `/sessions` picker and the static `/sessions tree` printout SHALL produce visually equivalent trees; they differ only in interactivity.

#### Scenario: Static and interactive trees match

- **WHEN** `/sessions tree` is invoked and `/sessions` is then invoked
- **THEN** both views SHALL show the same set of sessions
- **AND** both SHALL use the same ordering, indentation, and branch glyphs

### Requirement: Current session is highlighted in the tree

In both the picker and the static printout, the current session SHALL be visually distinguished from other rows (e.g., bold, color, or a `←` suffix). The exact visual treatment is implementation-specific but SHALL be unambiguous.

#### Scenario: Current session marked

- **WHEN** the tree is rendered while session `<C>` is active
- **THEN** the row corresponding to `<C>` SHALL carry a visual marker
- **AND** no other row SHALL carry that marker

### Requirement: Forks are visible at a glance

In any row representation, sessions whose `children` is non-empty SHALL display a fork indicator (e.g., a branch glyph or a child count like `(2)`). The exact visual treatment is implementation-specific.

#### Scenario: Parent row shows fork indicator

- **WHEN** a session has at least one child
- **THEN** its row SHALL include a fork indicator
- **AND** the indicator MAY include the child count

### Requirement: Ancestry shown for `/sessions <id>` detail view

The `/sessions <id>` detail output SHALL include an "Ancestry" line listing the chain from the root ancestor down to the requested session, with each ancestor shown as truncated id and createdAt.

#### Scenario: Deep ancestry rendered

- **WHEN** session `<D>` is a fork-of-fork-of-fork (depth 3)
- **AND** the user runs `/sessions <D>`
- **THEN** the detail output SHALL contain an "Ancestry:" line listing root → … → `<D>` in order
- **AND** each entry SHALL show truncated id and createdAt

### Requirement: Tree rendering is keyboard-only

The picker SHALL be fully operable from the keyboard: ↑/↓ to navigate rows, Enter to select, Escape to cancel. No mouse interaction SHALL be assumed or required.

#### Scenario: Picker navigation

- **WHEN** the picker is mounted with N rows
- **AND** the user presses ↓ to move to row K
- **AND** presses Enter
- **THEN** the session at row K SHALL be selected
- **AND** the TUI SHALL switch to that session
