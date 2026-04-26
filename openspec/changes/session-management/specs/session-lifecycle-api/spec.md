## ADDED Requirements

### Requirement: `POST /v1/sessions/:id/resume` loads a persisted session

The server SHALL expose `POST /v1/sessions/:id/resume`. It SHALL load the session from `~/.chimera/sessions/:id/` into the in-memory agent registry and return `{ sessionId }`.

#### Scenario: Resume existing session

- **WHEN** `POST /v1/sessions/:id/resume` is called with the id of a persisted session
- **THEN** the session SHALL be loaded into the in-memory registry
- **AND** subsequent `client.send(:id, …)` calls SHALL drive the resumed agent
- **AND** the response body SHALL be `{ "sessionId": ":id" }`

#### Scenario: Resume rejects unknown id

- **WHEN** `POST /v1/sessions/:id/resume` is called and `~/.chimera/sessions/:id/` does not exist
- **THEN** the server SHALL respond with HTTP 404
- **AND** an error body SHALL identify the missing session id

#### Scenario: Resume on already-active session is a no-op

- **WHEN** the resumed session is already in the in-memory registry
- **THEN** the server SHALL respond with `{ sessionId }` without reloading from disk

### Requirement: `POST /v1/sessions/:id/fork` creates a child session

The server SHALL expose `POST /v1/sessions/:id/fork` accepting an optional `{ purpose?: string }` body. It SHALL create a new session as a child of `:id` and return `{ sessionId, parentId }`.

#### Scenario: Fork session

- **WHEN** `POST /v1/sessions/<A>/fork` is called with `{ "purpose": "Try alternative approach" }`
- **THEN** a new session B SHALL be created with `parentId: A`
- **AND** B's `events.jsonl` SHALL be a copy of A's plus a `forked_from` event whose `purpose` is "Try alternative approach"
- **AND** A's `session.json` SHALL include B in its `children`
- **AND** the response SHALL be `{ "sessionId": "<B>", "parentId": "<A>" }`

#### Scenario: Fork rejects unknown id

- **WHEN** `POST /v1/sessions/:id/fork` is called and the parent does not exist
- **THEN** the server SHALL respond with HTTP 404

### Requirement: `GET /v1/sessions` reads from disk

The existing `GET /v1/sessions` endpoint SHALL be modified to return all sessions found on disk under `~/.chimera/sessions/`, not only those active in the in-memory registry. Each entry SHALL include `id`, `parentId`, `children`, `createdAt`, `messageCount`, `cwd`, and `model`. Results SHALL be served from a server-held cache that is invalidated on session create, fork, or delete.

#### Scenario: List includes persisted-but-inactive sessions

- **WHEN** sessions A and B exist on disk but only A is in the in-memory registry
- **AND** `GET /v1/sessions` is called
- **THEN** the response SHALL include both A and B

#### Scenario: List excludes pre-change flat files

- **WHEN** `~/.chimera/sessions/legacy.json` exists alongside `~/.chimera/sessions/<id>/`
- **AND** `GET /v1/sessions` is called
- **THEN** the response SHALL include `<id>` but NOT `legacy`

#### Scenario: Cache invalidates on mutation

- **WHEN** `POST /v1/sessions` creates a new session
- **AND** `GET /v1/sessions` is then called
- **THEN** the new session SHALL appear in the response

### Requirement: `DELETE /v1/sessions/:id` rejects sessions with children

The existing `DELETE /v1/sessions/:id` endpoint SHALL be modified to refuse deletion if the session has any children, responding with HTTP 409 and a clear error. Otherwise it SHALL remove the session directory and invalidate the list cache.

#### Scenario: Delete with children rejected

- **WHEN** session A has at least one entry in `children`
- **AND** `DELETE /v1/sessions/<A>` is called
- **THEN** the server SHALL respond with HTTP 409
- **AND** the error body SHALL list the child ids

#### Scenario: Delete leaf session succeeds

- **WHEN** session B has empty `children`
- **AND** `DELETE /v1/sessions/<B>` is called
- **THEN** `~/.chimera/sessions/<B>/` SHALL be removed
- **AND** B's parent's `children` SHALL no longer contain `<B>` after the next list

### Requirement: `ChimeraClient.listSessions` returns disk-scanned data

`ChimeraClient.listSessions(): Promise<SessionInfo[]>` SHALL return data sourced from the modified `GET /v1/sessions` endpoint, including `parentId`, `children`, and `messageCount` for every session.

#### Scenario: SDK lists sessions

- **WHEN** `client.listSessions()` is called
- **THEN** the result SHALL include all persisted sessions
- **AND** each entry SHALL have `parentId`, `children`, `createdAt`, `messageCount`, `cwd`, and `model`

### Requirement: `ChimeraClient.resumeSession`

`ChimeraClient` SHALL expose `resumeSession(sessionId: SessionId): Promise<void>` which POSTs to `/v1/sessions/:id/resume`.

#### Scenario: SDK resumes session

- **WHEN** `client.resumeSession(id)` is called
- **THEN** it SHALL POST to `/v1/sessions/:id/resume`
- **AND** subsequent `client.send(id, …)` calls SHALL drive the resumed agent

### Requirement: `ChimeraClient.forkSession`

`ChimeraClient` SHALL expose `forkSession(sessionId: SessionId, purpose?: string): Promise<{ sessionId: SessionId, parentId: SessionId }>` which POSTs to `/v1/sessions/:id/fork`.

#### Scenario: SDK forks session

- **WHEN** `client.forkSession(id, "Try different approach")` is called
- **THEN** it SHALL POST to `/v1/sessions/:id/fork` with `{ purpose: "Try different approach" }`
- **AND** SHALL return `{ sessionId, parentId: id }`

### Requirement: CLI resume entrypoint

The `chimera` CLI SHALL accept `chimera resume <id>` as a subcommand and `--resume <id>` as a top-level flag. Either form SHALL call `client.resumeSession(id)` and attach the TUI to the resumed session.

#### Scenario: CLI resume from cold start

- **WHEN** the user runs `chimera resume <id>` for a previously persisted session
- **THEN** the server SHALL load the session into memory
- **AND** the TUI SHALL render attached to that session
- **AND** the TUI header SHALL show that session's id

#### Scenario: CLI resume rejects unknown id

- **WHEN** the user runs `chimera resume <unknown-id>`
- **THEN** the CLI SHALL exit non-zero
- **AND** SHALL print a clear error identifying the missing session id
