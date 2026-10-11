## ADDED Requirements

### Requirement: apply_patch tool
When the model profile has `editFormat: "patch"`, the system SHALL register `apply_patch` in place of `edit`. `apply_patch` SHALL accept one patch in the Codex envelope and support adding, updating, deleting and moving files. It SHALL locate each hunk by its context lines, first exactly, then ignoring trailing whitespace, then ignoring leading and trailing whitespace. It SHALL apply no change when any part of the patch is malformed, targets a path outside the allowed directories, or has a hunk that cannot be located.

#### Scenario: Update a file
- **WHEN** a patch updates a file with one hunk whose context matches
- **THEN** the file has the new lines and the result lists the file as updated

#### Scenario: Add, delete and move
- **WHEN** a patch adds one file, deletes a second, and updates a third with `*** Move to:`
- **THEN** the first exists with the given content, the second is gone, and the third exists only at the new path

#### Scenario: Hunk does not match
- **WHEN** a patch has two file sections and the second has a hunk whose context is not in the file
- **THEN** the tool returns an error that names the file and the unmatched context, and the first file is unchanged

#### Scenario: Path outside the working directory
- **WHEN** a patch targets a path outside the allowed directories
- **THEN** the tool returns an error and writes nothing

### Requirement: Codex tool-call shape registers every tool
The `codex` tool-call shape SHALL register every tool that the `chimera` shape registers, under its codex-compatible name where one exists, and its `bash` tool SHALL accept `run_in_background` when background processes are available.

#### Scenario: Web and task tools under the codex shape
- **WHEN** tools are built with `toolCallShape: "codex"`, a web search backend, a task list and a recall store
- **THEN** `fetch`, `web_search`, `task_list`, `recall`, `bash_output` and `bash_kill` are registered

### Requirement: Tool prompt snippets
Every built-in tool definition SHALL carry a one-line prompt snippet that states what the tool is for.

#### Scenario: Built-in tools
- **WHEN** the built-in tools are built
- **THEN** every tool has a non-empty snippet

### Requirement: Allowlist aliases
A tool allowlist written with native tool names SHALL admit the equivalent tools of other profiles: `glob` SHALL admit `find` and `ls`, and `edit` SHALL admit `apply_patch`.

#### Scenario: Plan mode under the codex shape
- **WHEN** an allowlist of `read`, `glob`, `grep` is applied to a codex-shape tool set
- **THEN** `read`, `find`, `ls` and `grep` remain

### Requirement: Executor file removal
`Executor` SHALL provide `removeFile(path)`, which removes a file subject to the same path rules as `writeFile`.

#### Scenario: Remove inside the working directory
- **WHEN** `removeFile` is called for a file under the working directory
- **THEN** the file no longer exists

#### Scenario: Remove outside the allowed directories
- **WHEN** `removeFile` is called for a path outside the allowed write directories
- **THEN** it rejects with a path-escape error and the file is untouched
