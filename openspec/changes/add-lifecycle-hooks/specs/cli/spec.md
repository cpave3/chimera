# cli Specification (delta)

## ADDED Requirements

### Requirement: `chimera hooks list` subcommand

The CLI SHALL accept a `chimera hooks list` subcommand that, without starting a server or session, scans the two well-known hook directories and prints the discovered hooks in a stable tabular form.

The directories scanned SHALL be:

1. `~/.chimera/hooks/<EventName>/`
2. `<--cwd>/.chimera/hooks/<EventName>/` (defaulting to `process.cwd()` when `--cwd` is not passed)

For each event directory, the command SHALL list every executable file (regular file or symlink to a regular file with at least one execute bit set), grouped by event name and labelled with its scope (`global` or `project`). Non-executable files, directories, and broken symlinks SHALL be omitted.

The output SHALL include all events defined by the `lifecycle-hooks` spec, even those with no installed hooks (printed with an empty list under the heading) so that users can confirm an event name is recognized.

`chimera hooks list --json` SHALL emit a single JSON object on stdout of shape `{ events: { <EventName>: { global: string[], project: string[] } } }` and no other text. Paths SHALL be absolute.

The subcommand SHALL exit 0 if it ran to completion, regardless of whether any hooks were found. It SHALL exit 1 only on internal errors (e.g., permission denied reading a directory the user explicitly owns).

#### Scenario: Lists discovered project hook

- **WHEN** `<cwd>/.chimera/hooks/PostToolUse/audit.sh` exists with mode 0755 and the user runs `chimera hooks list`
- **THEN** stdout SHALL include a `PostToolUse` section listing the absolute path of `audit.sh` under the `project` scope, and the exit code SHALL be 0

#### Scenario: Empty event listed

- **WHEN** the user runs `chimera hooks list` and no hooks are installed for `Stop` in either directory
- **THEN** the output SHALL still include a `Stop` section with an empty list, confirming the event name is recognized

#### Scenario: JSON output

- **WHEN** the user runs `chimera hooks list --json`
- **THEN** stdout SHALL contain exactly one JSON object whose top-level key is `events` and whose value is a map from each event name in `lifecycle-hooks` to `{ global: string[], project: string[] }`, and stdout SHALL contain no other text
