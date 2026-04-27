## Context

Currently, Chimera only supports text-based user messages. The AI SDK supports multimodal content (text + images), but Chimera's message format (`{ content: string }`) and persistence model don't accommodate image attachments. Users want to share screenshots, error messages, and diagrams with vision-capable models like Claude or GPT-4V.

Key constraints:
- Terminal UI (Ink) cannot directly receive clipboard image paste events
- Session persistence stores messages as JSON; embedded base64 images would bloat files
- Backward compatibility needed for existing text-only sessions
- Image storage must respect user privacy (local filesystem only)

## Goals / Non-Goals

**Goals:**
- Enable users to attach local image files to messages via `/image <path>` slash command
- Support PNG, JPEG, GIF, and WebP formats up to 5MB
- Display image attachments in TUI scrollback as compact placeholders
- Persist images alongside sessions without bloating the message log
- Maintain backward compatibility with existing text-only sessions

**Non-Goals:**
- Direct clipboard paste (terminals don't provide structured clipboard access)
- Image editing or cropping within the TUI
- Automatic OCR or image analysis (the model handles that)
- Remote image URLs (local files only)
- Video or audio attachments

## Decisions

### DECISION: Use `/image` command instead of clipboard paste

**Rationale**: Terminals don't expose clipboard events for images. Bracketed paste mode only provides text. Platform-specific clipboard APIs (via `clipboardy` or native modules) add complexity and platform dependencies. File paths are explicit, auditable, and work across all platforms.

**Alternatives considered**:
- Platform-specific clipboard reading: Adds native dependencies, complex build setup
- Drag-and-drop: Not supported in terminal environments
- **Chosen**: `/image <path>` - simple, portable, explicit

### DECISION: Store images separately from message log

**Rationale**: Base64-encoded images bloat JSON files (4/3 size increase). Storing images as separate files in `~/.chimera/sessions/{id}/images/` keeps the message log readable and allows efficient loading of only referenced images.

**Format**: Each image stored with a UUID filename: `{imageId}.{ext}` (e.g., `01HX...ABC.png`). The message references by ID.

**Alternatives considered**:
- Embed base64 in JSON: Simpler but bloats persistence, harder to inspect
- **Chosen**: Separate files with references - cleaner, scalable

### DECISION: Structured content parts for messages

**Rationale**: The Vercel AI SDK expects messages as `{ role: 'user', content: Array<Part> }` where Part can be text or image. We align with this format for direct compatibility.

**Schema**:
```typescript
type ContentPart = 
  | { type: 'text'; text: string }
  | { type: 'image'; image: string } // base64 data URI
```

**Backward compatibility**: The API accepts both `{ content: string }` (legacy) and `{ parts: ContentPart[] }` (new).

**Alternatives considered**:
- Custom image field on message: Non-standard, requires translation layer
- **Chosen**: Standard AI SDK format - simpler, interoperable

### DECISION: Placeholders in TUI scrollback

**Rationale**: Ink (React for terminals) cannot reliably render images across terminal emulators. iTerm2 and Kitty support inline images, but most terminals don't. Placeholders ensure consistent UX everywhere.

**Format**: `[image: filename.png (245KB)]`

**Alternatives considered**:
- Inline image rendering with `terminal-image`: Only works in some terminals, adds dependency
- **Chosen**: Text placeholders - universal, accessible

### DECISION: 5MB size limit per image

**Rationale**: Large images consume model context tokens (expensive) and bandwidth. 5MB is generous for screenshots while preventing abuse. User can resize images externally if needed.

**Alternatives considered**:
- No limit: Risk of huge files, context overflow
- Automatic resizing: Complex, lossy, CPU-intensive
- **Chosen**: Hard limit with clear error - simple, predictable

## Risks / Trade-offs

**[Risk]** Image accumulation consumes disk space
→ **Mitigation**: Images are session-scoped; session deletion removes images directory. Document that users may need to periodically clean old sessions.

**[Risk]** Vision models not available for all providers
→ **Mitigation**: The system attaches images regardless; it's the model's responsibility to handle or ignore them. Future work could add model capability detection to warn users.

**[Risk]** Breaking change to `user_message` event structure
→ **Mitigation**: Keep `content` field as backward-compatible string serialization of text parts. New code checks for `parts` array first.

**[Risk]** Session portability (images not transferred with session export)
→ **Mitigation**: Document that session export only includes message references. Full portability requires copying the images directory.

**[Trade-off]** Placeholders vs inline images
→ Chose placeholders for universal compatibility, accepting reduced visual fidelity in supported terminals.

## Migration Plan

**Deployment**:
1. Deploy new server binary first (accepts both `content` and `parts`)
2. Deploy updated TUI (reads new event structure, shows placeholders)
3. Old sessions continue working unchanged

**Rollback**:
- Server rollback safe: continues accepting `content` strings
- TUI rollback: new sessions with image messages will show raw JSON or error; recommend clearing sessions before rollback

**Data migration**: None required. Existing text-only sessions work unchanged.

## Open Questions

1. Should we support animated GIFs? (Likely: treat as static image, model sees first frame)
2. Should we generate thumbnails for large images before base64 encoding? (Defer: adds complexity, models handle resizing)
3. Should we expose image deletion via `/image rm` or similar? (Defer: can clear entire session if needed)
