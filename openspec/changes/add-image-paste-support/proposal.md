## Why

Users want to share screenshots or image files with the AI for analysis (e.g., error messages, UI mockups, diagrams). Currently, Chimera only supports text input. Adding image paste support enables visual debugging, design feedback, and richer multimodal conversations with vision-capable models.

## What Changes

- Add the `/image <path>` slash command to attach local image files to messages
- Extend the message format to support multimodal content (text + image parts)
- Display image attachments in the TUI scrollback as `[image: filename.png]` placeholders
- Store attached images alongside session persistence
- Validate images before sending (size limits, supported formats)
- **BREAKING**: The `user_message` event structure changes from `{ content: string }` to support structured content parts

## Capabilities

### New Capabilities
- `image-attachments`: Support for attaching image files to user messages via `/image` command, including base64 encoding, persistence, and scrollback display

### Modified Capabilities
- `tui`: Add `/image` slash command and image attachment display in scrollback
- `agent-core`: Update message handling to support multimodal content (text + image parts) in the session
- `agent-server`: Extend the messages API to accept structured content with image parts

## Impact

**Packages affected**: `@chimera/tui`, `@chimera/core`, `@chimera/server`, `@chimera/client`

**API changes**:
- `POST /v1/sessions/:id/messages` accepts structured content parts instead of plain string
- `ChimeraClient.send()` signature changes to accept structured content

**Persistence changes**: Images stored in `~/.chimera/sessions/{id}/images/` directory

**Dependencies**: Uses Node.js `fs` for image reading, `path` for filename handling
