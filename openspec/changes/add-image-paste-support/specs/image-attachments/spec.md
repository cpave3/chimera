## ADDED Requirements

### Requirement: Image attachment via slash command

The system SHALL provide an `/image <path>` slash command that reads a local image file and attaches it to the current user message. The command SHALL validate the file exists, is a supported format (PNG, JPEG, GIF, WebP), and is under 5MB in size.

#### Scenario: Attaching a valid image
- **WHEN** the user types `/image screenshot.png` and submits
- **THEN** the system SHALL read the file, validate it, and attach it to the next message with a placeholder displayed in the TUI

#### Scenario: Invalid image file
- **WHEN** the user types `/image document.pdf` and submits
- **THEN** the system SHALL display an error `Invalid image format: document.pdf (supported: PNG, JPEG, GIF, WebP)` and SHALL NOT attach the file

#### Scenario: File not found
- **WHEN** the user types `/image missing.png` and submits
- **THEN** the system SHALL display an error `File not found: missing.png` and SHALL NOT attach the file

#### Scenario: Image too large
- **WHEN** the user types `/image huge.png` where the file exceeds 5MB
- **THEN** the system SHALL display an error `Image too large: huge.png (2.1MB > 5MB limit)` and SHALL NOT attach the file

### Requirement: Multipart message content

The system SHALL support user messages containing both text and image parts. When the user has attached images via `/image`, the next message submission SHALL include all attached images along with the text content.

#### Scenario: Message with text and images
- **WHEN** the user has attached `screenshot1.png` and `screenshot2.png` via `/image`, then types `compare these` and submits
- **THEN** the message SHALL contain text part `"compare these"` and two image parts with base64-encoded data

#### Scenario: Image-only message
- **WHEN** the user has attached `diagram.png` via `/image` and submits an empty message
- **THEN** the message SHALL contain only the image part with base64-encoded data

#### Scenario: Multiple images attach cumulatively
- **WHEN** the user types `/image a.png`, then `/image b.png`, then submits a message
- **THEN** the message SHALL contain both images attached

#### Scenario: Clear attachments on send
- **WHEN** the user attaches an image and submits a message
- **THEN** the attachment list SHALL be cleared for the next message

### Requirement: Image persistence

Images attached to messages SHALL be persisted alongside the session. Each image SHALL be stored in the session's images directory with a unique identifier and referenced from the message log.

#### Scenario: Image saved to session
- **WHEN** a message with an attached image is persisted
- **THEN** the image SHALL be saved to `~/.chimera/sessions/{sessionId}/images/{imageId}.{ext}`

#### Scenario: Image referenced in message log
- **WHEN** a message with an attached image is persisted
- **THEN** the persisted message SHALL reference the image by ID rather than embedding base64 data

#### Scenario: Session resume with images
- **WHEN** a session with image attachments is resumed
- **THEN** the images SHALL be loaded from disk and available for model context reconstruction

### Requirement: Scrollback display

The TUI SHALL display image attachments in the scrollback as compact placeholders showing the filename and size.

#### Scenario: Image placeholder in scrollback
- **WHEN** a message with `screenshot.png` (245KB) is displayed in scrollback
- **THEN** the TUI SHALL render `[image: screenshot.png (245KB)]` in the user message area

#### Scenario: Multiple images in one message
- **WHEN** a message with `a.png` and `b.png` is displayed
- **THEN** the TUI SHALL render `[image: a.png, b.png]` or separate placeholders for each image

### Requirement: Image format support

The system SHALL support PNG, JPEG, GIF, and WebP image formats. Images SHALL be base64-encoded when sent to the model.

#### Scenario: PNG support
- **WHEN** a PNG image is attached
- **THEN** the image SHALL be accepted and encoded as `image/png` MIME type

#### Scenario: JPEG support
- **WHEN** a JPEG image is attached
- **THEN** the image SHALL be accepted and encoded as `image/jpeg` MIME type

#### Scenario: GIF support
- **WHEN** a GIF image is attached
- **THEN** the image SHALL be accepted and encoded as `image/gif` MIME type

#### Scenario: WebP support
- **WHEN** a WebP image is attached
- **THEN** the image SHALL be accepted and encoded as `image/webp` MIME type
