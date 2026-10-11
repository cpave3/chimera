## Context

`LocalExecutor.exec` and `BackgroundProcessManager` run a command with
`sh -c`. The bash tool asks the permission gate first; the gate runs the
command policy pipeline, whose findings are `risk`, `path`, `unresolved`,
`elevation` (sudo), `blocked` and `analyzer_error`. `bubblewrap` 0.11 is on
the development machine and works without privileges.

## Goals / Non-Goals

**Goals:**

- The kernel, not the analyzer, keeps a command inside the project.
- Fewer prompts with the default settings.
- No way for a sandboxed command to widen its own sandbox.

**Non-Goals:**

- Sandboxing the file tools, MCP servers or the agent process itself.
- Hiding files from reads. Secrets in the home directory stay readable; the
  sandbox is about writes and, on request, the network.
- Windows.

## Decisions

### D1. Wrap the command string

`OsSandbox.wrap(command)` returns a shell command that starts the sandbox
and runs `sh -c <command>` inside it. The executor and the background
manager run that string as they ran the bare command, so nothing else in
their code changes. Linux:

```
bwrap --die-with-parent --ro-bind / / --dev /dev --proc /proc
      --bind <tmp> <tmp> --bind <cwd> <cwd> [--bind <write path> …]
      --ro-bind <cwd>/.chimera <cwd>/.chimera [--ro-bind <home>/.chimera …]
      [--unshare-net] --chdir <cwd> -- sh -c '<command>'
```

Later binds win, so the read-only binds come last. macOS gets a Seatbelt
profile: allow by default, deny `file-write*` outside the same directories,
deny it again for the protected ones, and deny `network*` when the network
is off.

### D2. `<cwd>/.chimera` is read-only as a whole

Hooks are found on every event and run outside the sandbox, so a sandboxed
command that could create `<cwd>/.chimera/hooks/PreToolUse/x` would escape
on the next tool call. A path that does not exist cannot be bound read-only,
so the factory creates `<cwd>/.chimera` when the sandbox is active.
Alternative: protect only `permissions.json` and `hooks/`. Rejected: both
may not exist yet, and the directory holds nothing a build writes.

The file tools do not run in the sandbox, so `LocalExecutor` gets a
write-deny list for `permissions.json` and `hooks/` in that directory.

### D3. Policy in the sandbox

The bash tool tells the gate that the command will run sandboxed. The gate
then drops `path` findings before it decides: the kernel refuses the write,
and reads are allowed by design. `elevation`, `risk`, `blocked` and
`analyzer_error` findings act as before. A command the user approved for
sudo runs outside the sandbox, where setuid works.

### D4. The unsandboxed request

`bash` takes `unsandboxed: true` with a `reason`. The gate treats it as
approval-required whatever the auto-approve level and the allow rules are,
and shows the reason; with no one to ask it is denied. The request carries
an `elevation` finding with the rule id `unsandboxed`, so clients show it
with what they already have.

### D5. Telling the model

When a sandboxed command fails and its stderr has the kernel's wording for a
refused write (`Read-only file system`), or, with the network off, for a
failed lookup or connection, the result gains a `sandbox` note: what the
sandbox allows, and that `unsandboxed: true` with a reason asks the user.
The match is a heuristic; a miss costs only the hint.

### D6. Availability

`auto`: on Linux, `bwrap` must be on `PATH` and a probe command must run
(user namespaces can be turned off); on macOS, `/usr/bin/sandbox-exec` must
exist. Without it the session warns once and runs commands as before.
`required` refuses every host command instead. The probe runs once for each
process.

### D7. The git directory

`git commit` writes the repository's git directory. In a linked worktree, a
submodule, or a session started below the repository root, that directory is
not below the working directory, and every commit would fail in the sandbox.
The factory therefore adds it to the writable paths: for a `.git` file, the
directory its `gitdir:` line names, or that directory's `commondir` when it
has one; for a `.git` directory above the working directory, that directory.
A repository whose `.git` is in the working directory needs nothing. This
gives a sandboxed command nothing it does not have in the plain case, where
`.git` is writable as part of the project.

### D8. Saying that the sandbox is on

With the sandbox active, the `bash` tool description says what a command may
write and how to ask for an unsandboxed run, so a small model does not have
to fail first. The TUI shows `sandbox os` where it showed `sandbox off`; the
CLI passes that state when it mounts the TUI.

### D9. A factory without a policy

`resolveHostBashPolicy` gives `auto`, and the three CLI commands always pass
its result. A factory that is built with no policy at all keeps `off`: it
does not probe the machine or create `.chimera` for a caller that did not
ask. The probe result is kept for the life of the factory.

## Risks / Trade-offs

- [A tool writes its cache outside the project] → the command fails with the
  note; `sandboxWritePaths` makes the directory writable for good.
- [An empty `.chimera/` appears in a project] → it is Chimera's own state
  directory, and it closes the hook escape.
- [Reads are not confined] → stated as a non-goal; the Docker sandbox is the
  tool for that.
- [The macOS profile is untested on a Mac] → the docs say so.
