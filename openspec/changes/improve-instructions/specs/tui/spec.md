## ADDED Requirements

### Requirement: Notice for a cut instruction file
When the session starts and an instruction file in the system prompt was cut to the size limit, the interactive TUI SHALL show one notice per such file with its path and size.

#### Scenario: Cut file
- **WHEN** the working directory's `AGENTS.md` is 50 KiB
- **THEN** the transcript starts with a notice that names the file and says that only its first 32 KiB are used
