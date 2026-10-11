## Context

`ModelConfig.toolCallShape` (`chimera` | `codex`) is the only per-model switch today. `buildTools` reads it and, for `codex`, hands the native tool definitions to `buildCodexToolDefs`, which returns a fixed subset under different names. The system prompt is `ROLE_PROMPT` plus a session block; for `codex` the factory appends an `# Active tools` list. The tool set is built once per session, and a `/model` change keeps it.

The current leaders adapt their surface per model: Claude Code removes search and todo tools for its newest models and keeps them, plus read-before-edit, for older ones; Codex gives GPT models a shell and `apply_patch`.

## Goals / Non-Goals

**Goals:**

- One resolved record per model decides tool names, edit format, prompt style and output budget.
- The prompt never names a tool that is not registered, and names every tool that is.
- GPT-family models edit with `apply_patch`; other models keep `edit`.
- Adding a model to config takes one line; unknown models get safe defaults.

**Non-Goals:**

- Consuming the output budget. Package 3 (`add-tool-guards`) does that.
- A shell-only tool set. Dedicated search tools stay for every profile, because they bypass the bash approval path.
- Renaming `toolCallShape`.

## Decisions

### Profile resolution lives in `@chimera/providers`

`resolveModelProfile({ modelId, contextWindow, options })` is a pure function next to `resolveContextWindow`, which already holds the known-model table. Family rules: a model id matching `gpt-`, `o<digit>` or `codex` gets `editFormat: 'patch'` and `promptStyle: 'lean'`; an id containing `claude` gets `replace` and `lean`; everything else gets `replace` and `guided`. Explicit `models.<ref>` values win field by field. The output budget is `clamp(round(contextWindow × 0.08), 2000, 25000)`.

Alternative considered: named presets (`"profile": "guided"`). Rejected: three independent fields are easier to override one at a time, and `toolCallShape` already exists as its own key.

### The prompt's tools section is generated

Every `ChimeraToolDef` carries `promptSnippet`. `composeSystemPrompt` receives `tools: { name, snippet }[]` and renders a `## Tools` section; the fixed "four built-in tools" text leaves `ROLE_PROMPT`. Tools registered outside `@chimera/tools` (MCP, `spawn_agent`) supply their own snippet; a tool without one is listed by name with the first sentence of its description. The section lists the tools left after the mode allowlist, so plan mode's prompt only shows what plan mode can call.

### `guided` adds rules, it does not replace the prompt

`lean` is today's prompt minus the fixed tool text. `guided` appends a `## Working method` section: pick the dedicated tool over bash for reading and searching, read a file before editing it, re-check after an edit, keep a task list for work with three or more steps, never repeat a failed call unchanged, and stop to ask when blocked.

### `apply_patch` as a JSON tool with one string field

The tool takes `{ patch: string }` in the Codex envelope (`*** Begin Patch` … `*** End Patch`, with `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:`). Chimera reaches GPT models through Chat Completions, which has no freeform-grammar tools, so the JSON form is the portable one. Hunks are located by context: exact match first, then ignoring trailing whitespace, then ignoring all leading and trailing whitespace — the same ladder the Codex CLI uses. The whole patch is parsed and every hunk located before any file is written, so a bad hunk leaves the tree unchanged. The tool uses the sandbox executor, so path rules, post-edit diagnostics and file tracking match `edit`.

`Executor.removeFile` is added for `Delete File` and `Move to`. `LocalExecutor` applies the same path check as `writeFile`.

### One tool set per profile, rebuilt on `/model`

The factory builds tool definitions through a function of the profile and caches the result per `(toolCallShape, editFormat)`. The model-change resolver returns the tool set, formatters and prompt for the new model's profile. History keeps the old tool names; providers accept tool calls in history that are absent from the current tool list.

### Allowlist aliases

Mode and agent allowlists are written with native names. `applyAllowlist` gains an alias table (`glob → find, ls`; `edit → apply_patch`) so `tools: [read, glob, grep]` works under every shape.

## Risks / Trade-offs

- [A prompt change shifts model behavior] → `lean` keeps the current wording; only the tool list is generated.
- [A family rule misclassifies a model] → every field can be set per model in config; `/model` shows the resolved profile.
- [A model switch mid-session changes tool names] → documented; the old names stay valid in history.
- [`apply_patch` applies a hunk to the wrong place] → a hunk must match exactly one location at the level that matches; the result names the match level.
