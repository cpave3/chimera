## 1. Core Types and Interfaces

- [ ] 1.1 Add `ContentPart` type to `@chimera/core` (text and image variants)
- [ ] 1.2 Extend `AgentEvent` types to support structured content in `user_message`
- [ ] 1.3 Add image metadata types (`ImageInfo`, `ImageAttachment`)

## 2. Image Validation and Utilities

- [ ] 2.1 Create `validateImageFile()` function (format, size checks)
- [ ] 2.2 Create `imageToBase64()` utility for encoding image files
- [ ] 2.3 Create `getImageMimeType()` function for format detection
- [ ] 2.4 Add unit tests for image validation functions

## 3. Persistence Layer

- [ ] 3.1 Create `~/.chimera/sessions/{id}/images/` directory on session creation
- [ ] 3.2 Implement `saveImageToSession()` for storing image files
- [ ] 3.3 Implement `loadImageFromSession()` for retrieving image data
- [ ] 3.4 Extend session persistence to handle image references in messages
- [ ] 3.5 Add `listSessionImages()` function for image metadata

## 4. Agent Core Message Handling

- [ ] 4.1 Update `Agent.run()` to accept structured content parts
- [ ] 4.2 Convert content parts to AI SDK format for `streamText`
- [ ] 4.3 Maintain backward compatibility for string message input
- [ ] 4.4 Update session persistence to serialize image references
- [ ] 4.5 Update session rehydration to load referenced images

## 5. Server API Changes

- [ ] 5.1 Update `POST /v1/sessions/:id/messages` to accept `parts` array
- [ ] 5.2 Maintain backward compatibility for `content` string field
- [ ] 5.3 Add `GET /v1/sessions/:id/images` endpoint
- [ ] 5.4 Add `GET /v1/sessions/:id/images/:imageId` endpoint
- [ ] 5.5 Add API tests for multimodal message endpoints

## 6. Client Updates

- [ ] 6.1 Extend `ChimeraClient.send()` to accept structured content parts
- [ ] 6.2 Add `ChimeraClient.listSessionImages()` method
- [ ] 6.3 Add `ChimeraClient.getImage()` method
- [ ] 6.4 Add client tests for multimodal message sending

## 7. TUI Image Command

- [ ] 7.1 Add `/image` to built-in slash commands list
- [ ] 7.2 Implement `/image <path>` handler with validation
- [ ] 7.3 Show error inline for invalid image files
- [ ] 7.4 Display image placeholders above input when attached
- [ ] 7.5 Clear attachment list after message submission
- [ ] 7.6 Support multiple cumulative `/image` attachments

## 8. TUI Scrollback Display

- [ ] 8.1 Update `ScrollbackEntry` to support image attachments
- [ ] 8.2 Update `renderEntryLines()` to show image placeholders
- [ ] 8.3 Format: `[image: filename.png (size)]` style display
- [ ] 8.4 Handle multiple images in single message

## 9. TUI Message Sending

- [ ] 9.1 Convert TUI internal state to structured content parts
- [ ] 9.2 Send `parts` array instead of plain string to client
- [ ] 9.3 Handle mixed text + image messages
- [ ] 9.4 Handle image-only messages (empty text)

## 10. Testing

- [ ] 10.1 Unit tests for image validation utilities
- [ ] 10.2 Unit tests for persistence layer image operations
- [ ] 10.3 Integration tests for multimodal message flow
- [ ] 10.4 TUI tests for `/image` slash command
- [ ] 10.5 TUI tests for image placeholder rendering
- [ ] 10.6 End-to-end test with actual image file

## 11. Documentation

- [ ] 11.1 Update TUI help text to document `/image` command
- [ ] 11.2 Add error message strings for validation failures
- [ ] 11.3 Document image size and format limitations
- [ ] 11.4 Update README with image attachment feature
