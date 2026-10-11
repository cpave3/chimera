## Context

`composeSystemPrompt` reads every `AGENTS.md`, `CLAUDE.md` and
`AGENTS.local.md` from the working directory up to the git root and appends
each in full. Tools run through `interceptTools` (package 3), whose `after`
hook may add fields to an object result. A mode's `tools` list is an
allowlist of names; `applyAllowlist` filters the registered tools with it.
`spawn_agent` resolves agent definitions at call time.

## Goals / Non-Goals

**Goals:**

- Instructions for a subdirectory reach the model when it starts work there.
- No instruction file and no skill library can take an unbounded share of
  the context.
- Plan mode can research, on the web and through the search helper, and
  still cannot change anything.

**Non-Goals:**

- Re-sending a nested instruction file after a compaction removed it.
- A general permission language for modes. The limit syntax carries one
  value list per tool.

## Decisions

### D1. Nested instructions ride on the tool result

An interceptor on `read`, `edit`, `write` and `apply_patch` resolves the
files the call touched. For each, it walks from the file's directory up to,
but not including, the working directory, outermost first, and collects the
instruction file of each directory that has one and was not sent before in
this session. The result gains `instructions: [{ path, content }]`. The same
precedence applies as at the root: `AGENTS.md`, else `CLAUDE.md`, plus
`AGENTS.local.md`. Alternative: add them to the system prompt when first
seen. Rejected: every such change would invalidate the provider's cache of
the whole conversation.

A failed call sends nothing. A string result (some tools return text) is
left alone; the four file tools return objects.

### D2. 32 KiB per instruction file

`readInstructionFile` returns the content cut at 32 KiB on a line boundary,
with a last line that says the file was cut and how large it is. Root files
and nested files share it. `oversizedInstructionFiles` lists the root files
that were cut; the interactive command passes that list to the TUI as
startup notices.

### D3. Skill index within 2% of the context window

`buildIndex({ maxTokens })` estimates four characters a token. Within the
limit it is unchanged. Over it, the index lists names grouped by skills
directory, one line per directory, and says where a skill's file is
(`<directory>/<name>/SKILL.md`), so the model can still open any skill.

### D4. Tool limits in mode files

A `tools` entry may be `name(value[, value…])`. The name goes into the
allowlist as before; the values are the mode's limit for that tool. A tool
enforces its own limit: the factory gives `spawn_agent` a function that
returns the active mode's limit, and a call outside it returns an error
without starting a child. Under an agent limit a call must name an allowed
`agent` and may not override `tools` or `system_prompt`, which would
otherwise turn a read-only helper into a writing one. A limit on a tool that
does not know limits gives a warning when the mode loads.

### D5. No `bash` in plan mode

Measured with the classifier Chimera ships: `echo hi > f`, `touch`, `mkdir`,
`cp`, `mv`, `sed -i`, `git commit` and `find -delete` all rate `safe`. A
`bash(safe)` limit would therefore let plan mode change files. Plan mode
stays without `bash`.

## Risks / Trade-offs

- [A nested instruction file is lost at compaction] → the summary keeps what
  mattered; the file is one `read` away.
- [The compact skill index has no descriptions] → names are usually enough
  to pick a skill, and the limit applies only to very large libraries.
- [A user mode names a limit for a tool without limits] → a warning, and the
  tool stays in the allowlist without a limit, as it was before.
