## Context

The system prompt is composed from the role prompt, the session block, the
instruction files and a list of `extensions` (the skills index is one). The
file tools run through an executor with `readAllowDirs` and `writeAllowDirs`
beside the working directory. All user state lives under `~/.chimera/`.

## Goals / Non-Goals

**Goals:**

- A fact the user gave once is there in the next session.
- No new tool and no new format: Markdown files the user can read and edit.
- The memory costs a bounded part of the context.

**Non-Goals:**

- Search or embeddings over memories. The index is the retrieval.
- Automatic extraction of memories after a session.
- Team-shared memory. Instruction files in the repository do that.

## Decisions

### D1. One memory for each repository, shared by its worktrees

The project root is the main working tree of the repository that holds the
working directory: found by walking up to `.git`, and, when `.git` is a
worktree's file, following its `gitdir` and `commondir` to the main
repository. Outside a repository it is the working directory. The project id
is that path with separators turned into dashes, so the directory name is
readable. Alternative: a hash of the path. Rejected: the user cannot tell
which directory belongs to which project. Legato runs agents in worktrees,
so memory keyed by worktree path would be lost with each task.

### D2. The index in the prompt, the topics on demand

The prompt section holds the directory path, the rules, and the first 200
lines of `MEMORY.md`. Topic files are read with the `read` tool when an index
line is relevant. The section is composed at session start and at `/reload`;
a memory saved during a session does not change the prompt of that session,
so the provider cache stays valid.

### D3. Rules follow the prompt style

`lean` (large models): save when the user states a lasting preference,
corrects the approach in a way that will matter again, or gives a fact about
the project that the repository does not record; one fact per file, one
index line per file; never save what the repository records or what matters
only to this task. `guided` (small models): save only when the user asks to
remember something. Small models over-apply an open rule and would fill the
memory with task notes.

### D4. Access

The memory directory is in the read list of the executor, and in its write
list for a top-level session. A subagent (depth above zero) gets the read
list only, and its prompt section says the memory is read-only. With a
Docker sandbox the file tools run in the container, which does not mount the
directory; the section then carries the index and says the files cannot be
reached in this session.

### D5. `/memory`

The TUI hands the terminal to `$VISUAL`/`$EDITOR` on the real `MEMORY.md`,
creating it with a one-line heading when it does not exist. Afterwards it
says that `/reload` brings the change into the running session.

## Risks / Trade-offs

- [The model saves noise] → the rules say what not to save; `guided` saves
  only on request; `/memory` lets the user prune; `memory.enabled: false`.
- [A wrong memory misleads later sessions] → the section tells the model
  that a memory is what was true when written, and to check it against the
  repository before relying on it.
- [Two sessions write the index at once] → the files are small and the edits
  are appends; the last writer wins, as with any file the user edits twice.
