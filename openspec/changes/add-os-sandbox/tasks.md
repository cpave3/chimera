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
- [x] 4.4 Test and correct the system prompt: `sandbox: os` and the file-access rule

## 5. Wrap-up

- [x] 5.1 Update `README.md` and `docs/bash-command-policy.md`
- [x] 5.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`

## 6. Automatic remembered-bypass retry

- [x] 6.1 Add fresh, non-prompting saved-rule authorization preserving denies and mandatory findings
- [x] 6.2 Retry recognized foreground sandbox failures once within the original timeout budget, retaining diagnostics
- [x] 6.3 Retry background failures under the same ID, retaining polling evidence and preventing relaunch after cancellation
- [x] 6.4 Verify registered-tool writes against real bubblewrap and negative authorization/cancellation cases
- [x] 6.5 Document retry behavior and the risk of repeated partial side effects
