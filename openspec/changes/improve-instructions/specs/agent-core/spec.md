## ADDED Requirements

### Requirement: Instruction file size limit
An instruction file (`AGENTS.md`, `CLAUDE.md`, `AGENTS.local.md`) SHALL contribute at most 32 KiB of its content to the model's context. A larger file SHALL be cut at a line boundary, and the cut content SHALL end with a line that says the file was cut and gives its full size.

#### Scenario: Large file
- **WHEN** the working directory's `AGENTS.md` is 50 KiB
- **THEN** the system prompt holds at most 32 KiB of it, followed by a line that says it was cut

#### Scenario: Small file
- **WHEN** the working directory's `AGENTS.md` is 2 KiB
- **THEN** the system prompt holds all of it and no such line

### Requirement: No instruction-file hunt in the role prompt
The role prompt SHALL NOT tell the model to look for or read `AGENTS.md` or `CLAUDE.md`. Chimera supplies those files.

#### Scenario: Prompt wording
- **WHEN** the system prompt is composed
- **THEN** the role section does not name `AGENTS.md`

### Requirement: Prompt recomposition for a live session
The CLI SHALL be able to compose the system prompt of a live session again from disk, with the same parts as at session start: the role prompt with the session's tool list, the instruction files, the skill index within its limit, and the active mode. `/reload` SHALL use this for the session on screen.

#### Scenario: Reload after an edit
- **WHEN** the user edits `AGENTS.md` and runs `/reload`
- **THEN** the session's system prompt has the new content and still has the tool list
