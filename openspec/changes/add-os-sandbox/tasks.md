## 1. Sandbox command

- [x] 1.1 Test and implement the `bwrap` command (writes, read-only paths, network) against real `bwrap`
- [x] 1.2 Test and implement the Seatbelt profile text
- [x] 1.3 Test and implement availability detection and the blocked-command note

## 2. Tools

- [x] 2.1 Test and implement sandboxed foreground and background `bash`, the `unsandboxed` argument and the `required` refusal
- [x] 2.2 Test and implement the write-deny list of `LocalExecutor`

## 3. Permissions

- [x] 3.1 Test and implement: path findings do not prompt in the sandbox; sudo runs outside it
- [x] 3.2 Test and implement the unsandboxed approval (always asked, headless denied, deny rule, audit)

## 4. CLI

- [x] 4.1 Test and add the config keys; detect and wire the sandbox in the factory; warn once
- [x] 4.2 Test and add the git directory of a worktree, a submodule or a parent repository to the writable paths
- [x] 4.3 Test and add the sandbox sentence of the `bash` description and the `sandbox os` label of the TUI

## 5. Wrap-up

- [x] 5.1 Update `README.md` and `docs/bash-command-policy.md`
- [x] 5.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`
