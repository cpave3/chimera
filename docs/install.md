# Installing and updating Chimera

## Install script

On Linux (x86_64 or aarch64) or a Mac with Apple silicon:

```
curl -fsSL https://raw.githubusercontent.com/cpave3/chimera/main/install.sh | sh
```

- The script picks the binary for your OS and CPU, downloads it and the
  release's `SHA256SUMS` from the newest release, and checks the binary's
  checksum. On a mismatch it stops and installs nothing.
- The binary goes to `~/.local/bin/chimera` (the directory is made when it
  is missing). If that directory is not on your `PATH`, the script says so
  and prints the line to add to your shell profile.
- `CHIMERA_INSTALL_DIR` puts it somewhere else. Any other OS or CPU gets
  an error naming the platforms that are built.
- Running the script again installs the newest release over the old one.

## Manual download

Each release has one file per platform and a `SHA256SUMS`:

| Platform | File |
| --- | --- |
| Linux x86_64 | `chimera-linux-amd64` |
| Linux aarch64 | `chimera-linux-arm64` |
| macOS, Apple silicon | `chimera-darwin-arm64` |

`releases/latest/download/<file>` is always the newest release:

```
base=https://github.com/cpave3/chimera/releases/latest/download
file=chimera-linux-amd64
curl -fL -O "$base/$file" -O "$base/SHA256SUMS"
grep " $file\$" SHA256SUMS | sha256sum -c       # macOS: ... | shasum -a 256 -c
mkdir -p ~/.local/bin && install -m 0755 "$file" ~/.local/bin/chimera
```

A release page also lists a build provenance attestation;
`gh attestation verify chimera-linux-amd64 --repo cpave3/chimera` checks it.

## Running from source

```
corepack enable
pnpm install
pnpm -r build
pnpm link --global      # puts `chimera` on your PATH
chimera --version       # dev
```

This needs Node.js 20 or later. A build from source reports the version
`dev`: it never updates itself, and `chimera update` leaves it alone. Pull
and run `pnpm -r build` to update it. `pnpm unlink --global` removes the
link; without one, run `node packages/cli/dist/bin.js <args>`.

## Uninstall

```
rm ~/.local/bin/chimera     # or wherever `command -v chimera` points
rm -rf ~/.chimera           # optional: config, sessions, logs, themes, hooks
```

Projects may also hold a `.chimera/` directory of their own.

## Updating

A Chimera installed from a release can replace itself with a newer one:

```
chimera update                      # install the newest release
chimera update --check              # only say whether a newer release exists
chimera update --version v0.3.1     # install that release, e.g. to go back after a bad one
chimera update --check --json       # {"current", "latest", "available", "url"}
```

- `chimera update` asks GitHub for the newest stable release of
  `cpave3/chimera` (never a draft or a prerelease), without a token; GitHub
  allows 60 such requests an hour.
- The binary for your OS and CPU is downloaded beside the one you run
  (a link such as `~/.local/bin/chimera` is followed, and the file it leads
  to is replaced), checked against the release's `SHA256SUMS`, made
  executable and run: `<new> version --json` has to report the release's
  version. Only then is it renamed over the old one. Sessions, servers and
  subagents already running keep the old binary until they restart.
- When any step fails (a failed download, a checksum that does not match,
  a binary that reports another version), the installed binary is left as
  it was and the reason is printed. No copy of the old binary is kept:
  `--version` installs an older release instead.
- A build from source (`chimera version` says `dev`) is never changed:
  `chimera update` refuses and says so. `--check` still works.
- With `--json`, an install prints the same object plus `"updated"`. The
  output follows `st update --json`, so a tool that keeps `st` current can
  drive `chimera` the same way.

### Background updates

The TUI and `chimera serve` look for a newer release a minute after they
start, then every six hours. `updates.mode` in `~/.chimera/config.json`
decides what they do with one:

```json
{ "updates": { "mode": "auto" } }
```

| `mode` | What happens |
| --- | --- |
| `auto` (default) | The new release is installed in the background. The TUI shows `updated to vX.Y.Z, restart to use` in the transcript and in the status line; `chimera serve` prints it to stderr. |
| `ask` | Nothing is installed. The TUI shows `vX.Y.Z available · chimera update`. |
| `off` | No check is made. |

- No check is made by a build from source, when `CI` is set, by
  `chimera run`, or by the server of a subagent (its parent checks).
- A failed check or install is shown in the status line and tried again at
  the next check.
