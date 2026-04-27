## ADDED Requirements

### Requirement: Multimodal message content

The `user_message` event and `Session.messages` SHALL support structured content parts including both text and image data. Image parts SHALL include the base64-encoded image data and MIME type.

#### Scenario: Message with text and image parts
- **WHEN** a user sends a message with text "analyze this" and an attached PNG image
- **THEN** the `user_message` event SHALL contain `{ type: "text", text: "analyze this" }` and `{ type: "image", image: "data:image/png;base64,..." }` parts

#### Scenario: Image persistence in session
- **WHEN** a message with an image is persisted to disk
- **THEN** the image SHALL be stored separately in `~/.chimera/sessions/{id}/images/` and referenced by ID in the message

## MODIFIED Requirements

### Requirement: Session lifecycle and state

The `Session` object carries conversation history. Message content SHALL be extended to support multimodal parts while remaining compatible with AI SDK `ModelMessage` format.

The session's `messages` array SHALL contain objects with `role` and `content`, where `content` MAY be either a string (legacy text-only) or an array of parts. Each part SHALL have a `type` field in `["text", "image"]`.

Text parts: `{ type: "text", text: string }`
Image parts: `{ type: "image", image: string }` where the string is a base64 data URI (`data:image/{format};base64,...`)

#### Scenario: Session created with multimodal support
- **WHEN** the consumer calls `new Agent(opts)` with multimodal configuration
- **THEN** `agent.session.messages` SHALL be able to store messages with text and image parts

#### Scenario: Session resumed with image messages
- **WHEN** the consumer constructs an `Agent` with `opts.sessionId` matching a session that contains image messages
- **THEN** `agent.session` SHALL deserialize messages with image parts correctly, loading referenced images from disk

### Requirement: Agent run loop

The `Agent.run()` method SHALL handle messages with multimodal content and pass them to the AI SDK `streamText` in the correct format.

The loop SHALL translate multimodal messages into the AI SDK's expected format: `content` as an array of `{ type: "text", text: string } | { type: "image", image: string }` objects.

#### Scenario: Single-turn run with image attachment
- **WHEN** the consumer iterates `agent.run()` with a message containing text and an image
- **THEN** the event sequence SHALL include `user_message` with structured content parts, followed by model response events

#### Scenario: Text-only message backward compatibility
- **WHEN** the consumer iterates `agent.run("hello")` with a plain string
- **THEN** the message SHALL be handled as `{ role: "user", content: "hello" }` (existing behavior preserved)

### Requirement: Session persistence

Session persistence SHALL handle multimodal messages by storing images separately and referencing them in the JSON.

On every `step_finished`, `@chimera/core` SHALL serialize the current `Session` as JSON. Messages with image parts SHALL be serialized with image references instead of embedded base64 data.

#### Scenario: Persisted session with images
- **WHEN** an agent completes a step containing a message with an image attachment
- **THEN** the on-disk session file SHALL contain a reference to the image, and the image SHALL be saved separately in the session's images directory

#### Scenario: Resume reconstructs image messages
- **WHEN** a session with image messages is resumed
- **THEN** the loaded session SHALL contain messages with image data loaded from the images directory
