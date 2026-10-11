# Instructions, memory and context

This page describes what goes into the model's context and how Chimera keeps
a long session inside the context window: your instruction files, the
project's memory, compaction, and the task list.

## Project instructions

Chimera puts `AGENTS.md` (or `CLAUDE.md` where there is no `AGENTS.md`) and
`AGENTS.local.md` into the system prompt, from the working directory up to
the git root. You do not have to tell the agent to read them.

- **Subdirectories.** A package deeper in the tree can have its own
  instruction file. The first time the agent reads, edits or writes a file in
  such a directory, the tool result carries that file (and those of the
  directories between it and the working directory), once a session. The
  system prompt does not change, so the provider's cache stays valid.
- **Size limit.** An instruction file adds at most 32 KiB to the context. A
  larger file is cut at a line boundary with a note for the model, and the
  TUI tells you at start. Keep the file short and point to longer documents
  the agent can read when it needs them.
- **Skills.** The skill index takes at most 2% of the model's context
  window. A library too large for that is listed by name per skills
  directory, without descriptions; the agent can still open any skill.
- **`/reload`** composes the system prompt again from disk for the session on
  screen: instruction files, skills, mode and tool list as they are now.

## Project memory

Chimera keeps a small memory for each project, so a preference you stated or
a correction you made is there in the next session.

- **Where.** `~/.chimera/projects/<project-id>/memory/`: a `MEMORY.md` index
  and one Markdown file for each fact. The project is the repository that
  holds the working directory, and every git worktree of that repository
  shares the same memory. The project id is the repository's path with dashes
  for separators.
- **What a session loads.** The first 200 lines of `MEMORY.md` go into the
  system prompt at session start, with the directory's path. The agent reads
  a topic file when its index line is relevant. A memory saved during a
  session does not change that session's prompt; `/reload` loads it.
- **When the agent saves.** A model with the `lean` prompt style saves when
  you state a lasting preference, correct its approach, or tell it a fact
  about the project that the repository does not record. A model with the
  `guided` style saves only when you ask it to remember something. Neither
  saves what the code, the git history or the instruction files already say.
- **`/memory`** opens the index in `$VISUAL` / `$EDITOR`. The files are plain
  Markdown; edit or delete them as you like.
- **Access.** A top-level session reads and writes the memory with the
  ordinary file tools. A subagent can read it and cannot write it. In a
  Docker sandbox the file tools cannot reach the directory, so the agent has
  the index only.
- **Off switch.** `"memory": { "enabled": false }` in `~/.chimera/config.json`.

## Context management

Three layers keep a long session inside the context window, for a small
window as well as a large one. The full description is in
[Context compaction](COMPACTION.md).

- **Mid-run auto-compaction.** The agent projects the next prompt from the
  provider's *actual* reported token usage (falling back to a char/4 estimate
  before the first step) and compacts when it crosses
  `min(window × thresholdPercent, window − reserve)` — checked at run start
  **and between steps**, so long tool loops never die on a window overflow.
  Configure with `compaction.thresholdPercent` (default 85).
- **Tiered compaction.** Phase 1 archives old large tool outputs to the
  recall store and leaves `recall({ id: "pr_..." })` stubs in place — no LLM
  call, and the conversation skeleton survives. Only if that isn't enough
  does phase 2 summarize the oldest messages. The `recall` tool fetches
  archived outputs back (with `start_line`/`end_line`/`search` slicing);
  entries live under `~/.chimera/recall/<sessionId>/` and expire after
  `recall.ttlDays` (default 30). Disable with `"recall": { "enabled": false }`.
- **`/context`.** Shows the window, the actual last-prompt size, the current
  estimate, the auto-compact trigger, and a per-category breakdown (system
  prompt, summary, user/assistant messages, tool results, archived stubs).

## Task list

For multi-step work the model maintains a task list via the `task_list` tool
(replace-whole-list semantics, statuses `pending` / `in_progress` /
`completed`). During a run the task panel above the prompt shows the task in
progress and what follows; the footer keeps the count and the task in progress
(`tasks 2/5 · ◼ implement feature`). The
list is persisted in session
metadata, so it survives resume, forks, and context compaction. The model
sees the list through its latest `task_list` call; when compaction summarizes
that call away, the summary ends with a `<tasks>` block that restates every
task and status. The list is deliberately not part of the system prompt, so a
task update does not invalidate the provider's prompt cache. Scrollback
renders each update as a compact progress line (`2/5 done → current task`).

Plan mode hands off into this: the model presents its plan as a numbered
markdown list, and when you accept it (switch out of plan mode), a one-shot
system note on the next run tells it to record the plan via `task_list` and
execute against it.
