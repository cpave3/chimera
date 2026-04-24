## ADDED Requirements

### Requirement: Executor interface

`@chimera/tools` SHALL export an `Executor` interface with members `exec(cmd, opts?)`, `readFile(path)`, `readFileBytes(path)`, `writeFile(path, content)`, `stat(path)`, `cwd()`, and `target()`. `exec()` SHALL return `{ stdout, stderr, exitCode, timedOut }`. `target()` SHALL return `"sandbox"` or `"host"`.

Tools defined in this package SHALL NEVER import `node:child_process` or `node:fs` directly; every filesystem or process action SHALL go through an `Executor`.

#### Scenario: Tool reads a file through the executor

- **WHEN** the `read` tool runs against a `LocalExecutor` with `path: "src/foo.ts"`
- **THEN** the tool SHALL invoke `executor.readFile("src/foo.ts")` and SHALL NOT import `node:fs` itself

### Requirement: LocalExecutor

`@chimera/tools` SHALL provide a `LocalExecutor` class implementing `Executor` by delegating to `node:fs/promises` and `node:child_process.spawn`. Its `target()` SHALL return `"host"`.

`LocalExecutor` SHALL resolve all relative paths against the `cwd` given at construction and SHALL REJECT any path that, after resolution, is not a descendant of that `cwd`. Absolute paths outside `cwd` and `..` traversals that escape `cwd` SHALL throw a `PathEscapeError` before any I/O.

`LocalExecutor.exec()` SHALL honor `opts.timeoutMs` (defaulting to `120_000`), sending SIGTERM on timeout and SIGKILL if the process has not exited within 2 seconds of SIGTERM. It SHALL set `timedOut: true` in the result when a timeout occurred.

#### Scenario: Path escape is rejected

- **WHEN** `LocalExecutor` is constructed with `cwd = "/home/u/proj"` and any of `readFile("/etc/passwd")`, `readFile("../other/file")`, or `writeFile("/tmp/x", "")` is called
- **THEN** the call SHALL reject with a `PathEscapeError` and no I/O SHALL be performed

#### Scenario: exec timeout

- **WHEN** `LocalExecutor.exec("sleep 60", { timeoutMs: 100 })` is called
- **THEN** the returned `ExecResult` SHALL have `timedOut: true` and `exitCode !== 0`, and the spawned child SHALL no longer be running after the call returns

### Requirement: Tool set built by `buildTools`

`@chimera/tools` SHALL export `buildTools(ctx: ToolContext): Record<string, Tool>` where the returned record always contains keys `"bash"`, `"read"`, `"write"`, `"edit"`. `ToolContext` SHALL carry `sandboxExecutor`, `hostExecutor`, `permissionGate`, and `sandboxMode`. In MVP `sandboxExecutor === hostExecutor` because `sandboxMode` is always `"off"`.

Tools SHALL be defined using the Vercel AI SDK `tool()` helper with Zod parameter schemas.

#### Scenario: Built tool set contains the four core tools

- **WHEN** `buildTools(ctx)` is called with any valid context
- **THEN** the returned record SHALL have exactly the keys `"bash"`, `"read"`, `"write"`, `"edit"` (no more, no fewer)

### Requirement: `bash` tool

The `bash` tool SHALL accept `{ command: string, timeout_ms?: number, target?: "sandbox" | "host", reason?: string }` and SHALL return `{ stdout: string, stderr: string, exit_code: number, timed_out: boolean }`.

In MVP, `target` defaults to `"host"` when `sandboxMode === "off"`. When `sandboxMode !== "off"` and `target === "host"`, the call SHALL be routed through `ctx.permissionGate` and `reason` SHALL be required; the gate SHALL return `{ error: "reason required" }` if `reason` is missing. (This routing is specified now so future sandbox additions are additive; in MVP the gate path is unreachable because `sandboxMode` is always `"off"`.)

`bash` SHALL refuse, returning an error result without executing, any command matching a fixed list of known-destructive patterns: `rm -rf /`, `rm -rf /*`, `:(){ :|:& };:` (fork bomb), and any write into `/etc/` that is not a read-only operation. This is a guardrail against accidents, not a security boundary.

#### Scenario: Destructive command refused

- **WHEN** the model calls `bash` with `command: "rm -rf /"`
- **THEN** the tool SHALL return `{ stdout: "", stderr: "refused by chimera: matches destructive pattern …", exit_code: -1, timed_out: false }` and no process SHALL be spawned

#### Scenario: Default target when sandbox is off

- **WHEN** the model calls `bash` with `command: "echo hi"` and omits `target`
- **THEN** the tool SHALL execute on the host executor and return the command's real stdout `"hi\n"`

### Requirement: `read` tool

The `read` tool SHALL accept `{ path: string, start_line?: number, end_line?: number }` and SHALL return `{ content: string, total_lines: number, truncated: boolean }`. `content` SHALL be line-number-prefixed (`<lineNo>\t<text>`).

It SHALL enforce a soft limit of 2000 lines and a hard limit of 100 KB of content; whichever is reached first triggers truncation and sets `truncated: true`. `read` SHALL always use `ctx.sandboxExecutor` (file reads are safe and do not need a `target` parameter).

#### Scenario: Reading a file larger than 2000 lines

- **WHEN** `read` is called on a 3000-line file without `start_line` / `end_line`
- **THEN** `content` SHALL contain at most 2000 numbered lines starting from line 1, `total_lines` SHALL equal 3000, and `truncated` SHALL be `true`

#### Scenario: Reading a specific range

- **WHEN** `read` is called with `{ path: "f", start_line: 10, end_line: 12 }`
- **THEN** `content` SHALL contain exactly the three lines numbered 10, 11, 12

### Requirement: `write` tool

The `write` tool SHALL accept `{ path: string, content: string }` and SHALL return `{ bytes_written: number, created: boolean }`. It SHALL overwrite existing files, create parent directories as needed, and refuse paths outside `ctx.sandboxExecutor.cwd()`. It SHALL always use `ctx.sandboxExecutor`.

#### Scenario: Writing a new file

- **WHEN** `write` is called with a path that does not yet exist under `cwd`
- **THEN** the file and any missing parent directories SHALL be created, `bytes_written` SHALL equal the UTF-8 byte length of `content`, and `created` SHALL be `true`

#### Scenario: Writing outside cwd is refused

- **WHEN** `write` is called with an absolute path or `../`-escaping path that resolves outside `cwd`
- **THEN** the call SHALL return an error result (no file is written) and emit a `tool_call_error` event

### Requirement: `edit` tool

The `edit` tool SHALL accept `{ path: string, old_string: string, new_string: string, replace_all?: boolean }` and SHALL perform exact, non-regex string replacement. It SHALL return `{ replacements: number }`.

If `old_string` occurs zero times, the call SHALL error with message `"old_string not found"`. If it occurs more than once and `replace_all !== true`, the call SHALL error with message `"old_string matches N occurrences; pass replace_all=true or disambiguate"`.

#### Scenario: Unique match

- **WHEN** `edit` is called on a file where `old_string` appears exactly once
- **THEN** the file SHALL be rewritten with that single occurrence replaced by `new_string` and the result SHALL be `{ replacements: 1 }`

#### Scenario: Ambiguous match

- **WHEN** `edit` is called with `replace_all` unset on a file where `old_string` appears twice
- **THEN** the file SHALL NOT be modified and the tool SHALL return an error result naming the count of matches
