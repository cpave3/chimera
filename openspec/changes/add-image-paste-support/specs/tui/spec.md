## ADDED Requirements

### Requirement: Image slash command

The TUI SHALL support an `/image <path>` slash command that validates and attaches image files to the current message composition.

#### Scenario: Successful image attachment
- **WHEN** the user types `/image screenshot.png` and presses Enter
- **THEN** the TUI SHALL validate the file exists and is a supported format, display a placeholder `[image: screenshot.png]` above the input, and clear the input line

#### Scenario: Image attachment error
- **WHEN** the user types `/image invalid.pdf` and presses Enter
- **THEN** the TUI SHALL display an error message inline and SHALL NOT add any attachment

#### Scenario: Multiple image attachments
- **WHEN** the user types `/image a.png`, then `/image b.png`
- **THEN** the TUI SHALL display placeholders for both images above the input

### Requirement: Image attachment display

When a user message contains image attachments, the TUI scrollback SHALL render compact placeholders showing the filename and size.

#### Scenario: Single image in message
- **WHEN** a user message containing `diagram.png` (124KB) appears in scrollback
- **THEN** the TUI SHALL render `[image: diagram.png (124KB)]` alongside the text content

#### Scenario: Multiple images in message
- **WHEN** a user message containing `a.png` and `b.png` appears in scrollback
- **THEN** the TUI SHALL render `[image: a.png, b.png]` or separate placeholders for each image

#### Scenario: Image-only message
- **WHEN** a user message contains only an image attachment
- **THEN** the TUI SHALL render the image placeholder with no text content

## MODIFIED Requirements

### Requirement: Built-in slash commands

The list of built-in slash commands SHALL be extended to include image attachment support.

`/image <path>` — validate and attach a local image file to the current message. Validates that the file exists, is a supported format (PNG, JPEG, GIF, WebP), and is under 5MB. Displays an error inline for invalid files, or a placeholder for valid attachments. Multiple `/image` calls accumulate until the next message is sent.

#### Scenario: Unknown slash command still shows hint
- **WHEN** a user types `/imag` (typo) and presses Enter
- **THEN** the TUI SHALL render `unknown command: /imag — did you mean /image?` inline

#### Scenario: Image command help
- **WHEN** a user types `/help` and presses Enter
- **THEN** the TUI SHALL list `/image` in the built-in commands with description "Attach an image file to the current message"
