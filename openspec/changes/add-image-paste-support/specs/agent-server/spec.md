## ADDED Requirements

### Requirement: Image attachment endpoints

The server SHALL expose endpoints for managing image attachments to sessions.

- `GET /v1/sessions/:id/images` → `ImageInfo[]` — lists all images attached to the session.
- `GET /v1/sessions/:id/images/:imageId` → image data — returns the image file with appropriate `Content-Type` header.

Image metadata SHALL include: `id`, `filename`, `size`, `mimeType`, `createdAt`.

#### Scenario: List session images
- **WHEN** a client GETs `/v1/sessions/<id>/images` for a session with attached images
- **THEN** the response SHALL return an array of image metadata objects

#### Scenario: Retrieve image data
- **WHEN** a client GETs `/v1/sessions/<id>/images/<imageId>` for a valid image
- **THEN** the response SHALL return the image bytes with the correct `Content-Type` header

## MODIFIED Requirements

### Requirement: Messaging and interruption

The messaging endpoint SHALL accept structured content parts instead of a plain string, enabling multimodal messages with text and image content.

- `POST /v1/sessions/:id/messages` with body `{ parts: ContentPart[] }` SHALL queue a run on the session's agent. Each `ContentPart` SHALL be either `{ type: "text", text: string }` or `{ type: "image", image: string }` where the image string is a base64 data URI.

For backward compatibility, the endpoint SHALL also accept `{ content: string }` (legacy format) and treat it as a single text part.

#### Scenario: Multimodal message accepted
- **WHEN** a client POSTs to `/v1/sessions/<id>/messages` with `{ parts: [{type: "text", text: "hello"}, {type: "image", image: "data:image/png;base64,..."}] }`
- **THEN** the server SHALL respond `202 Accepted` and the message SHALL be processed with both text and image parts

#### Scenario: Legacy text message still works
- **WHEN** a client POSTs to `/v1/sessions/<id>/messages` with `{ content: "hello" }`
- **THEN** the server SHALL respond `202 Accepted` and treat the message as a single text part (backward compatibility)

#### Scenario: Second message during active run is rejected (unchanged behavior)
- **WHEN** a client POSTs a second message to `/v1/sessions/<id>/messages` while the first run is still in progress
- **THEN** the server SHALL respond `409 Conflict` and the in-flight run SHALL continue unaffected
