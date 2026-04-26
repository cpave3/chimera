## ADDED Requirements

### Requirement: Sessions stored in directory structure

Each session SHALL be stored at `~/.chimera/sessions/<session-id>/` containing `session.json` (metadata) and `events.jsonl` (append-only event log).

#### Scenario: Session directory created on init

- **WHEN** a new session is created via `client.createSession()` or `Agent` construction
- **THEN** the directory `~/.chimera/sessions/<session-id>/` SHALL exist
- **AND** the directory SHALL contain `session.json`
- **AND** the directory SHALL contain `events.jsonl` (initially empty)

### Requirement: `session.json` schema

`session.json` SHALL contain exactly the following fields, JSON-encoded:
- `id`: ULID (the session id)
- `parentId`: ULID or `null`
- `children`: array of ULIDs
- `createdAt`: integer Unix milliseconds
- `cwd`: absolute path string
- `model`: full `ModelConfig` object
- `sandboxMode`: one of `"off" | "bind" | "overlay" | "ephemeral"`
- `usage`: usage tally object

`session.json` SHALL NOT contain `messages` or `toolCalls`. It SHALL be written via tmp-file plus atomic rename.

#### Scenario: session.json contents on a forked session

- **WHEN** session B is forked from session A
- **THEN** `~/.chimera/sessions/<B>/session.json` SHALL have `parentId: <A>`
- **AND** `~/.chimera/sessions/<A>/session.json` SHALL include `<B>` in its `children`
- **AND** B's `usage` field SHALL be reset to a zero tally

#### Scenario: session.json never contains conversation state

- **WHEN** any session is persisted
- **THEN** `session.json` SHALL NOT include `messages` or `toolCalls` at any key path

### Requirement: Events stored as JSONL

All persisted events SHALL be appended to `events.jsonl` as one JSON object per line. The file SHALL only be appended to and SHALL never be modified in place.

The persisted event types SHALL be `step_finished`, `permission_resolved`, `run_finished`, and `forked_from`. Other event types SHALL be transient.

#### Scenario: Event appended to log

- **WHEN** a run step completes
- **THEN** the `step_finished` event SHALL be appended to `events.jsonl` as a new line
- **AND** existing lines SHALL NOT be modified

#### Scenario: Transient events are not persisted

- **WHEN** an `assistant_text_delta`, `tool_call_start`, `tool_call_result`, `tool_call_error`, `permission_request`, or `user_message` event is emitted
- **THEN** the event SHALL NOT appear in `events.jsonl`

### Requirement: Resume reads metadata then snapshot

When resuming a session, the system SHALL:
1. Read `session.json` to populate config (`cwd`, `model`, `sandboxMode`, `parentId`, `children`, `usage`).
2. Scan `events.jsonl` line by line, skipping blank or malformed lines with a logged warning.
3. Take the most recent `step_finished` event and use its payload to populate `messages` and `toolCalls`.
4. Set `status = "idle"`.

#### Scenario: Session resumed from disk

- **WHEN** a session is resumed
- **THEN** the system SHALL read `session.json` for config
- **AND** SHALL load `messages`/`toolCalls` from the most recent `step_finished` event
- **AND** the resumed `messages` SHALL match what was in memory at the end of the previous run

#### Scenario: Malformed trailing line is tolerated

- **WHEN** `events.jsonl` ends with a partial or non-JSON line (e.g., from a crash mid-append)
- **THEN** the resume SHALL succeed using the most recent well-formed `step_finished`
- **AND** a warning SHALL be logged identifying the skipped line

### Requirement: Root sessions have null `parentId`

Sessions created without a `parentSessionId` SHALL have `parentId: null` and SHALL appear as roots when the session tree is rendered.

#### Scenario: New session is root

- **WHEN** a session is created via `/new` (or `client.createSession()` without a fork)
- **THEN** its `session.json` SHALL have `parentId: null`

### Requirement: Fork copies parent's event log

Forking session A to produce session B SHALL:
1. Allocate a fresh ULID for B.
2. Create `~/.chimera/sessions/<B>/`.
3. Copy A's `events.jsonl` to B's directory verbatim.
4. Append a `forked_from { parentId: <A>, parentEventCount: <line-count>, purpose?: string }` event to B's `events.jsonl`.
5. Write B's `session.json` with `parentId: <A>`, empty `children`, fresh `createdAt`, `usage` reset to zero, and `cwd`/`model`/`sandboxMode` copied from A.
6. Update A's `session.json` to include `<B>` in `children`.

Subsequent appends to B's `events.jsonl` SHALL NOT affect A's `events.jsonl`.

#### Scenario: Child events do not leak to parent

- **WHEN** session B is forked from A and B runs additional steps
- **THEN** new `step_finished` events SHALL appear in B's `events.jsonl` only
- **AND** A's `events.jsonl` SHALL be byte-identical to its state before the fork (apart from any concurrent activity in A itself)

#### Scenario: forked_from event carries provenance

- **WHEN** B is created as a fork of A
- **THEN** B's `events.jsonl` SHALL contain exactly one `forked_from` event whose `parentId` is A's id
- **AND** that event SHALL appear after the copied events from A

### Requirement: Fork in `overlay` sandbox mode snapshots the upperdir

When forking a session whose `sandboxMode` is `"overlay"`, the system SHALL copy `~/.chimera/overlays/<parentId>/upper/` to `~/.chimera/overlays/<childId>/upper/` so that the child has an independent overlay state.

For `"off"`, `"bind"`, and `"ephemeral"` modes, no filesystem copy SHALL be performed; the child shares the parent's `cwd`.

#### Scenario: Overlay fork produces independent upperdir

- **WHEN** session A is in overlay mode and is forked to session B
- **THEN** `~/.chimera/overlays/<B>/upper/` SHALL exist and contain a copy of A's upperdir contents at fork time
- **AND** writes by B SHALL NOT appear in A's upperdir

#### Scenario: Bind-mode fork shares cwd

- **WHEN** session A is in bind mode and is forked to session B
- **THEN** B SHALL inherit A's `cwd`
- **AND** no per-session filesystem copy SHALL be made

### Requirement: Pre-change flat session files are ignored

`<id>.json` files at `~/.chimera/sessions/<id>.json` (the pre-change format) SHALL NOT be loaded or listed by any code path. They SHALL be left in place untouched.

#### Scenario: Legacy flat files do not appear in listings

- **WHEN** the sessions directory contains both `~/.chimera/sessions/old-id.json` (legacy flat file) and `~/.chimera/sessions/new-id/` (new directory)
- **THEN** disk scans SHALL return only `new-id`
- **AND** the legacy file SHALL remain on disk untouched
