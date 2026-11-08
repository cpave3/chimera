# Installing and updating Chimera

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
