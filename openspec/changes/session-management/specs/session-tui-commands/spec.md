## ADDED Requirements

### Requirement: `/new` creates and switches to a new root session

The `/new` command SHALL replace the existing stub. It SHALL call `client.createSession()` with the current configuration, switch the TUI to the new session, clear the scrollback, and print a confirmation showing the truncated id.

#### Scenario: User creates new session

- **WHEN** the user types `/new` and presses Enter
- **THEN** `client.createSession()` SHALL be called
- **AND** the TUI SHALL switch to the new session
- **AND** scrollback SHALL be cleared
- **AND** a confirmation line SHALL display the truncated session id

### Requirement: `/sessions` opens an interactive picker

The `/sessions` command SHALL replace the existing stub. With no argument it SHALL open an interactive picker showing all persisted sessions in tree order. With argument `tree` it SHALL print the same tree as a static scrollback block. With argument `<id>` it SHALL print details for that session.

#### Scenario: User opens the picker

- **WHEN** the user types `/sessions` and presses Enter
- **THEN** an interactive picker SHALL mount over the scrollback
- **AND** each row SHALL show: a tree-prefix indicating depth, truncated id, relative createdAt, message count, and the basename of `cwd`
- **AND** rows SHALL be ordered by root-session `createdAt` descending, with each root's descendants inlined under it

#### Scenario: Picker switches sessions

- **WHEN** the picker is mounted with multiple sessions
- **AND** the user navigates with ↑/↓ and presses Enter on a row
- **THEN** the TUI SHALL call `client.resumeSession(id)`
- **AND** SHALL switch to that session
- **AND** SHALL close the picker

#### Scenario: Picker cancellation

- **WHEN** the picker is mounted
- **AND** the user presses Escape
- **THEN** the picker SHALL unmount with no session change

#### Scenario: `/sessions tree` prints static tree

- **WHEN** the user types `/sessions tree` and presses Enter
- **THEN** an ASCII tree SHALL be appended to scrollback
- **AND** the tree SHALL show parent-child relationships with branch glyphs (e.g., `├──`, `└──`)
- **AND** the current session SHALL be marked (e.g., a `←` suffix or color)

#### Scenario: `/sessions <id>` prints details

- **WHEN** the user types `/sessions <id>` and presses Enter
- **THEN** scrollback SHALL show: full id, full cwd, model id, parent id (or "root"), child count, and the ancestry chain from root to that session

### Requirement: `/fork [purpose]` creates a child session

The `/fork` command SHALL call `client.forkSession(currentSessionId, purpose)`, switch to the resulting child session, clear scrollback, and print a confirmation noting the parent.

#### Scenario: User forks the current session

- **WHEN** the user types `/fork Try alternative approach` and presses Enter
- **THEN** `client.forkSession(currentSessionId, "Try alternative approach")` SHALL be called
- **AND** the TUI SHALL switch to the returned child session
- **AND** scrollback SHALL be cleared
- **AND** the confirmation SHALL show the truncated child id and parent id

#### Scenario: User forks without a purpose

- **WHEN** the user types `/fork` and presses Enter
- **THEN** `client.forkSession(currentSessionId)` SHALL be called with no purpose
- **AND** the rest of the flow SHALL match the with-purpose case

### Requirement: TUI header shows session id and fork status

The TUI header SHALL display the truncated current session id at all times. When the current session has a non-null `parentId`, the header SHALL include a `(forked)` marker. When the current session has children, the header MAY include a child count.

#### Scenario: Header on a root session

- **WHEN** the current session is a root (`parentId` is null)
- **THEN** the header SHALL show the truncated id
- **AND** SHALL NOT show a `(forked)` marker

#### Scenario: Header on a forked session

- **WHEN** the current session has a non-null `parentId`
- **THEN** the header SHALL show the truncated id
- **AND** SHALL include a `(forked)` marker

### Requirement: Composer is disabled while picker is mounted

While the `/sessions` picker is mounted, the TUI's main composer input SHALL not accept keystrokes. The picker SHALL receive all keyboard events.

#### Scenario: Composer ignores keystrokes during picker

- **WHEN** the picker is mounted
- **AND** the user types text
- **THEN** the composer SHALL NOT receive the keystrokes
- **AND** the picker SHALL handle navigation keys
