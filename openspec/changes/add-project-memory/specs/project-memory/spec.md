## ADDED Requirements

### Requirement: Memory location
Chimera SHALL keep a project's memory in `~/.chimera/projects/<project-id>/memory/`. The project SHALL be the main working tree of the git repository that holds the working directory, so that every worktree of one repository has the same memory; outside a repository it SHALL be the working directory. The project id SHALL be the project's absolute path with path separators replaced by `-`.

#### Scenario: Repository subdirectory
- **WHEN** a session starts in `/home/u/code/app/packages/api` and `/home/u/code/app` is the repository root
- **THEN** the memory directory is `~/.chimera/projects/-home-u-code-app/memory`

#### Scenario: Worktree
- **WHEN** a session starts in a linked worktree of the repository at `/home/u/code/app`
- **THEN** the memory directory is the same as for `/home/u/code/app`

#### Scenario: No repository
- **WHEN** a session starts in `/tmp/scratch`, which is in no repository
- **THEN** the memory directory is `~/.chimera/projects/-tmp-scratch/memory`

### Requirement: Memory in the system prompt
When memory is enabled, the system prompt SHALL have a project memory section with the path of the memory directory, the rules for using it, and the first 200 lines of `MEMORY.md`. When the index is longer, the section SHALL say that it was cut. When there is no index, the section SHALL say that the memory is empty. The section SHALL be composed at session start and at reload, and SHALL NOT change when a memory is saved during the session.

#### Scenario: Index loaded
- **WHEN** `MEMORY.md` has 12 lines
- **THEN** the system prompt holds all 12 lines under the project memory section

#### Scenario: Long index
- **WHEN** `MEMORY.md` has 350 lines
- **THEN** the system prompt holds its first 200 lines and a note that 150 more exist

#### Scenario: No memory yet
- **WHEN** the memory directory does not exist
- **THEN** the section names the directory and says that nothing is saved yet

### Requirement: Saving rules follow the prompt style
With the `lean` prompt style the section SHALL tell the model to save a memory when the user states a lasting preference, corrects the approach, or gives a project fact that the repository does not record, and SHALL tell it what not to save. With the `guided` style it SHALL tell the model to save only when the user asks. Both SHALL give the file layout: one topic file for each fact and one index line for each file.

#### Scenario: Lean
- **WHEN** the model's prompt style is `lean`
- **THEN** the section says to save when the user states a lasting preference or corrects the approach

#### Scenario: Guided
- **WHEN** the model's prompt style is `guided`
- **THEN** the section says to save only when the user asks

### Requirement: Memory access
The file tools of a top-level session SHALL be able to read and write files in the memory directory. A subagent SHALL be able to read them and SHALL NOT be able to write them, and its section SHALL say so. With a Docker sandbox, the section SHALL say that the memory files cannot be reached in this session.

#### Scenario: Write
- **WHEN** the model of a top-level session writes `<memory>/testing.md`
- **THEN** the write succeeds

#### Scenario: Subagent
- **WHEN** a subagent tries to write a file in the memory directory
- **THEN** the write is refused

### Requirement: Memory can be turned off
With `memory.enabled` set to `false`, the system prompt SHALL have no project memory section and the file tools SHALL have no access to the memory directory.

#### Scenario: Disabled
- **WHEN** `memory.enabled` is `false`
- **THEN** the system prompt does not name the memory directory, and a read of a file in it is refused
