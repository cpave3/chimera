# agent-server Specification

## Purpose

The `@chimera/server` package exposes a Hono-based HTTP + SSE server that hosts one or more agent sessions. It binds to loopback by default, exposes REST endpoints for session/message/permission management, and streams `AgentEvent`s via Server-Sent Events with resume support.

## Requirements

### Requirement: HTTP + SSE server bound to loopback

`@chimera/server` SHALL expose a Hono-based HTTP server that, on `start()`, binds to `127.0.0.1` on an ephemeral port (port `0`) and reads back the OS-assigned port. The server SHALL refuse to start bound to any non-loopback address unless the CLI explicitly passes `--host 0.0.0.0` (documented-warning path) — in which case it SHALL emit a conspicuous stderr warning before binding.

No authentication SHALL be required on any endpoint in MVP.

#### Scenario: Default bind uses an ephemeral loopback port

- **WHEN** the server is started without `--port` or `--host`
- **THEN** it SHALL listen on `127.0.0.1:<dynamic>`, where `<dynamic>` is returned from the OS, and that port SHALL be reported via the `/v1/instance` response and any lockfile written by the CLI

### Requirement: Session endpoints

The server SHALL expose:

- `POST   /v1/sessions` → `{ sessionId }` — creates a new agent/session bound to the server instance.
- `GET    /v1/sessions` → `Session[]` — lists sessions known to the instance.
- `GET    /v1/sessions/:id` → `Session` — returns the full serialized session snapshot.
- `DELETE /v1/sessions/:id` → `204` — disposes the session.

Each session SHALL have its own `Agent` instance, its own executor chain, and its own rule store scopes.

#### Scenario: Create then fetch a session

- **WHEN** a client POSTs to `/v1/sessions` with `{ cwd: "/tmp/x", model: {...}, sandboxMode: "off" }` and then GETs `/v1/sessions/<returned-id>`
- **THEN** the GET response SHALL return a `Session` object whose `id` matches, whose `cwd` is `/tmp/x`, and whose `status` is `"idle"`

### Requirement: Messaging and interruption

- `POST /v1/sessions/:id/messages` with body `{ content: string }` SHALL queue a run on the session's agent. If a run is already active, the server SHALL respond `409`. On success, the server SHALL respond `202` immediately — the run's events are delivered via SSE, not the POST response.
- `POST /v1/sessions/:id/interrupt` SHALL call `Agent.interrupt()` and respond `204`. Calling interrupt when no run is active SHALL also respond `204` (idempotent no-op).

#### Scenario: Second message during active run is rejected

- **WHEN** a client POSTs a second message to `/v1/sessions/<id>/messages` while the first run is still in progress
- **THEN** the server SHALL respond `409 Conflict` and the in-flight run SHALL continue unaffected

### Requirement: Permission endpoints

- `POST /v1/sessions/:id/permissions/:requestId` with body `{ decision: "allow"|"deny", remember?: RememberScope }` SHALL resolve the matching pending request. Repeated calls for the same `requestId` SHALL respond `409 Conflict` after the first resolution (idempotent rejection).
- `POST /v1/sessions/:id/permissions/rules` with body `{ rule: PermissionRule, scope: "session"|"project" }` SHALL add a rule directly and respond `201`.
- `GET  /v1/sessions/:id/permissions/rules` SHALL list all currently active rules (session + project).
- `DELETE /v1/sessions/:id/permissions/rules/:idx` SHALL remove the rule at the given index in the list returned by the GET; out-of-range indices SHALL respond `404`.

#### Scenario: Duplicate permission resolution

- **WHEN** a client POSTs to `/v1/sessions/<id>/permissions/<rid>` twice with identical bodies
- **THEN** the first call SHALL respond `204` and the second call SHALL respond `409`

### Requirement: Event stream with resume

`GET /v1/sessions/:id/events` SHALL return a Server-Sent Events stream. Every event SHALL be serialized as `event: agent_event`, an `id: <eventId>` line, and a JSON `data:` line whose payload is the `AgentEvent` augmented with `{ eventId, sessionId, ts }`.

The server SHALL maintain a ring buffer of at least the last 1000 events per session. Clients MAY pass `?since=<eventId>`; the server SHALL replay events that came after the given `eventId` (inclusive of any still in the buffer, in order) before joining the live stream. Multiple SSE subscribers per session SHALL all receive every event.

#### Scenario: Resume skips already-delivered events

- **WHEN** a client reconnects with `?since=E42` after the stream had emitted events E40, E41, E42, E43, E44
- **THEN** the reconnected stream SHALL emit exactly E43 and E44 from the buffer before delivering any new events

### Requirement: Instance and health endpoints

- `GET /v1/instance` SHALL return `{ pid, cwd, version, sandboxMode, parentId? }`. `parentId` SHALL be present only if the CLI was started with `--parent <sessionId>` (reserved for future subagents).
- `GET /healthz` SHALL return `200 OK` with body `"ok"` once the server is accepting connections.

#### Scenario: Healthz during startup

- **WHEN** any HTTP client requests `/healthz` against a fully started server
- **THEN** the response SHALL have status 200 and body `"ok"` within 50 ms on loopback
