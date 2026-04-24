# agent-sdk Specification

## Purpose

The `@chimera/client` package provides the TypeScript SDK (`ChimeraClient`) used by the TUI and other consumers to interact with a Chimera server over HTTP + SSE. It wraps session management, message send/subscribe as AsyncIterables, permission resolution, and rule management.

## Requirements

### Requirement: ChimeraClient constructor

`@chimera/client` SHALL export a `ChimeraClient` class constructed with `{ baseUrl: string, fetch?: typeof fetch }`. When `fetch` is omitted, the global `fetch` SHALL be used. The `baseUrl` SHALL be an `http://127.0.0.1:<port>` URL in normal usage but the class SHALL NOT hard-code loopback — any URL that responds with the server's endpoints works.

The client SHALL NOT import `@chimera/server` or `@chimera/core` implementation code; it SHALL depend only on types from `@chimera/core`.

#### Scenario: Custom fetch implementation

- **WHEN** a consumer constructs `new ChimeraClient({ baseUrl, fetch: customFetch })`
- **THEN** every HTTP call made by the client SHALL route through `customFetch` and not through `globalThis.fetch`

### Requirement: Session management methods

`ChimeraClient` SHALL expose:

- `createSession(opts): Promise<{ sessionId }>` — POST `/v1/sessions`.
- `listSessions(): Promise<Session[]>` — GET `/v1/sessions`.
- `getSession(id): Promise<Session>` — GET `/v1/sessions/:id`.
- `deleteSession(id): Promise<void>` — DELETE `/v1/sessions/:id`.

#### Scenario: Round-trip create and fetch

- **WHEN** a consumer calls `await client.createSession({ cwd, model, sandboxMode: "off" })` and then `await client.getSession(result.sessionId)`
- **THEN** the returned `Session` object SHALL match the server's snapshot and the `id` field SHALL equal `result.sessionId`

### Requirement: Send and subscribe as AsyncIterables

`client.send(sessionId, message, opts?)` SHALL POST the message to `/v1/sessions/:id/messages`, open an SSE subscription to `/v1/sessions/:id/events`, and return an `AsyncIterable<AgentEvent>` that yields events until the stream emits a `run_finished` event (inclusive).

`client.subscribe(sessionId, { sinceEventId? })` SHALL return an `AsyncIterable<AgentEvent>` that attaches to an existing run or idle session and yields events indefinitely. If `sinceEventId` is provided, it SHALL be passed as `?since=` on the SSE GET so that server-side buffered events are replayed first.

If the network connection drops mid-stream, the client SHALL transparently reconnect using the last observed `eventId` as `sinceEventId` up to a reasonable retry count (default 3, with exponential backoff) before surfacing an error.

#### Scenario: `send` yields events until terminal

- **WHEN** a consumer iterates `client.send(id, "hi")`
- **THEN** the iteration SHALL yield a sequence ending with exactly one `run_finished` event, after which the iterator SHALL complete cleanly

#### Scenario: Auto-reconnect on transient network error

- **WHEN** the SSE connection is severed mid-run and the server is still alive
- **THEN** the client SHALL reopen the connection with `?since=<last eventId>` and continue yielding events without duplication

### Requirement: Permission resolution

`client.resolvePermission(sessionId, requestId, decision, remember?)` SHALL POST to `/v1/sessions/:id/permissions/:requestId` with the given decision. A `409` response SHALL be surfaced as a thrown `PermissionAlreadyResolvedError` so the caller can distinguish "lost the race" from transport errors.

The client SHALL NOT maintain its own pending-request state; the server is authoritative.

#### Scenario: Race-losing resolver

- **WHEN** two consumers both call `resolvePermission` on the same `requestId`
- **THEN** one call SHALL return normally and the other SHALL reject with `PermissionAlreadyResolvedError`

### Requirement: Rule management methods

`client.addRule(sessionId, rule, scope)`, `client.listRules(sessionId)`, and `client.removeRule(sessionId, index)` SHALL wrap the corresponding `/permissions/rules` HTTP endpoints. Types exposed through these methods SHALL be identical to the ones in `@chimera/permissions` (imported via `@chimera/core` types barrel).

#### Scenario: listRules matches server state

- **WHEN** a consumer calls `addRule(sessionId, R, "session")` and then `listRules(sessionId)`
- **THEN** the listed rules SHALL include `R`

### Requirement: Permission-request timeout signal

When iterating events from `send()` or `subscribe()`, if a `permission_request` event has been observed and no corresponding `permission_resolved` arrives within a configurable deadline (default 5 minutes), the client SHALL yield a synthetic `{ type: "permission_timeout", requestId }` event and then end the iterator. The server-side request is NOT automatically resolved by the client — the caller must decide whether to deny, allow, or retry.

#### Scenario: Idle permission prompt times out

- **WHEN** the iterator has yielded a `permission_request` event with `requestId: R1` and no resolver calls the server for 5 minutes
- **THEN** the iterator SHALL yield `{ type: "permission_timeout", requestId: "R1" }` and complete
