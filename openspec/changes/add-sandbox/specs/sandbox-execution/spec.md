## ADDED Requirements

### Requirement: DockerExecutor implements the Executor interface

`@chimera/sandbox` SHALL provide a `DockerExecutor` class implementing the `Executor` interface defined by `@chimera/tools`. Its `target()` SHALL return `"sandbox"`. Every filesystem and process action SHALL proxy to a long-lived container via `docker exec`; `DockerExecutor` SHALL NOT invoke `node:fs` or `node:child_process` directly against the host.

#### Scenario: bash tool routes to container

- **WHEN** a session is created with `sandboxMode: "bind"` and the model calls `bash { command: "echo hello", target: "sandbox" }`
- **THEN** the resulting `tool_call_result` SHALL contain `stdout: "hello\n"` produced by a process running inside the sandbox container, not on the host

### Requirement: Container lifecycle

`DockerExecutor.start()` SHALL issue `docker run -d --name chimera-<sessionId> --workdir /workspace <mount-args> <image> sleep infinity` and record the resolved container name. `DockerExecutor.stop()` SHALL issue `docker rm -f <name>` and tolerate the container already being gone.

Between `start()` and `stop()`, `exec()` SHALL issue `docker exec -i <name> -w <relCwd> sh -c '<cmd>'`, piping stdin when provided, passing env via `-e`, and enforcing `timeoutMs` by sending SIGTERM (via `docker kill --signal=SIGTERM`) followed by SIGKILL after 2 s.

#### Scenario: stop is idempotent

- **WHEN** `DockerExecutor.stop()` is invoked twice
- **THEN** the second call SHALL return without error even though the container has already been removed

#### Scenario: exec timeout kills the container process

- **WHEN** `exec("sleep 60", { timeoutMs: 100 })` is called
- **THEN** the returned `ExecResult` SHALL have `timedOut: true`, and after the call no `sleep 60` process SHALL remain running inside the container

### Requirement: Mount strategy per mode

`DockerExecutor.start()` SHALL apply mount arguments based on the requested `SandboxMode`:

- `"bind"`: `-v <hostCwd>:/workspace:rw` only.
- `"overlay"`: `-v <hostCwd>:/lower:ro` + `-v <hostUpperDir>:/upper` where `<hostUpperDir>` is `~/.chimera/overlays/<sessionId>/` with `upper/` and `work/` subdirectories auto-created. The container entrypoint SHALL `mount -t overlay overlay -o lowerdir=/lower,upperdir=/upper/data,workdir=/upper/work /workspace` before `exec sleep infinity`.
- `"ephemeral"`: same as overlay but `/upper` SHALL be backed by `--tmpfs /upper`, so nothing persists past `stop()`.

The container SHALL receive `--cap-add SYS_ADMIN --security-opt apparmor=unconfined` only for `overlay` and `ephemeral`, not `bind`.

#### Scenario: bind mode writes land on the host

- **WHEN** in `bind` mode the model writes a file via the `write` tool, then the session exits
- **THEN** the file SHALL be present on the host at `<hostCwd>/<path>` immediately after the write (before and after session exit)

#### Scenario: ephemeral mode discards writes

- **WHEN** in `ephemeral` mode the model writes a file via the `write` tool, then `DockerExecutor.stop()` is called
- **THEN** the file SHALL NOT be present on the host at `<hostCwd>/<path>` afterwards

### Requirement: Overlay fallback detection

When the requested mode is `"overlay"` or `"ephemeral"`, `DockerExecutor.start()` SHALL attempt the overlay mount once. If the mount fails (non-zero exit from the entrypoint, missing `CAP_SYS_ADMIN`, kernel without overlayfs, etc.), `DockerExecutor.start()` SHALL:

- If `--sandbox-strict` was NOT passed: stop the failed container, restart in `"bind"` mode, and cause the CLI to log a warning to stderr and a `run_finished`-pre-step informational log entry explaining the fallback.
- If `--sandbox-strict` was passed: stop the container, log a clear error, and throw so the CLI can exit non-zero.

#### Scenario: Fallback logs but continues

- **WHEN** `--sandbox --sandbox-mode overlay` is requested on a host without overlayfs support and without `--sandbox-strict`
- **THEN** the session SHALL proceed using `bind` mode and stderr SHALL contain a warning naming the reason for fallback

#### Scenario: Strict mode refuses fallback

- **WHEN** the same host and mode request is made WITH `--sandbox-strict`
- **THEN** `DockerExecutor.start()` SHALL throw, the CLI SHALL exit with a non-zero status, and no session SHALL be created

### Requirement: Overlay diff-and-apply

In `overlay` mode, on session end (run completion, user `/discard`/`/apply`, or `chimera run` exit), `DockerExecutor` SHALL produce a diff list using `rsync --dry-run -rln --delete <upperdir>/data/ <hostCwd>/` partitioned into `modified`, `added`, `deleted`.

For interactive TUI sessions, the CLI SHALL render this list and offer: apply all, apply selected, discard, keep overlay for later. On "apply" the implementation SHALL run `rsync -a [--delete] <upperdir>/data/ <hostCwd>/` limited to the selected paths. On "keep", `<upperdir>` SHALL be preserved and resuming the session SHALL re-mount the same overlay.

For non-TTY `chimera run` sessions, the default SHALL be `discard` unless `--apply-on-success` was passed, in which case the full overlay SHALL be applied iff `run_finished.reason === "stop"`.

In `ephemeral` mode, no diff is computed; the upperdir is tmpfs and is discarded with the container.

#### Scenario: Apply selected file subset

- **WHEN** the TUI picker returns `{ selected: ["a.ts", "b.ts"], discarded: ["c.ts"] }` after an overlay session
- **THEN** `a.ts` and `b.ts` from the upperdir SHALL be rsynced onto the host, `c.ts` SHALL remain as its pre-session state on the host, and the upperdir SHALL be removed

#### Scenario: `--apply-on-success` with non-stop exit

- **WHEN** a `chimera run --sandbox-mode overlay --apply-on-success` invocation ends with `run_finished.reason === "max_steps"`
- **THEN** the upperdir SHALL NOT be applied and it SHALL be discarded

### Requirement: Default image and build escape hatch

`DockerExecutor` SHALL use `ghcr.io/<org>/chimera-sandbox:v<major>.<minor>` (version aligned with the `@chimera/cli` package version) as the default image. A CLI flag `--sandbox-image <ref>` SHALL override this default.

`@chimera/sandbox` SHALL include a `Dockerfile` at `packages/sandbox/docker/Dockerfile` building a Debian-slim base with git, curl, node, python3, build-essential, ripgrep, jq, and fd-find installed. The CLI SHALL expose a `chimera sandbox build` subcommand that runs `docker build -t chimera-sandbox:dev packages/sandbox/docker/` and prints the resulting image ref.

#### Scenario: Build produces a local image

- **WHEN** a user runs `chimera sandbox build` on a host with Docker installed
- **THEN** the command SHALL exit 0, Docker SHALL report `chimera-sandbox:dev` in `docker images`, and the command's stdout SHALL include that tag

### Requirement: Network and resource flags

`DockerExecutor` SHALL honor:

- `--sandbox-network none|host` (default `host`, meaning default Docker bridge, i.e. network enabled) → translated to `--network` on `docker run`.
- `--sandbox-memory <size>` (default `2g`) → `--memory`.
- `--sandbox-cpus <n>` (default `2`) → `--cpus`.

These flags apply to all three modes.

#### Scenario: Network isolation

- **WHEN** a session is started with `--sandbox --sandbox-network none` and the model runs `bash { command: "curl -sS https://example.com" }` with `target: "sandbox"`
- **THEN** the tool result SHALL have a non-zero `exit_code` and stderr indicating network unreachability, and no outbound connection SHALL appear in the host's network telemetry attributable to the container
