## 1. Sandbox command

- [ ] 1.1 Test and implement the `bwrap` command (writes, read-only paths, network) against real `bwrap`
- [ ] 1.2 Test and implement the Seatbelt profile text
- [ ] 1.3 Test and implement availability detection and the blocked-command note

## 2. Tools

- [ ] 2.1 Test and implement sandboxed foreground and background `bash`, the `unsandboxed` argument and the `required` refusal
- [ ] 2.2 Test and implement the write-deny list of `LocalExecutor`

## 3. Permissions

- [ ] 3.1 Test and implement: path findings do not prompt in the sandbox; sudo runs outside it
- [ ] 3.2 Test and implement the unsandboxed approval (always asked, headless denied, deny rule, audit)

## 4. CLI

- [ ] 4.1 Test and add the config keys; detect and wire the sandbox in the factory; warn once

## 5. Wrap-up

- [ ] 5.1 Update `README.md` and `docs/bash-command-policy.md`
- [ ] 5.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`
