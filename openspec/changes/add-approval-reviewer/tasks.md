## 1. Reviewer rules

- [x] 1.1 Test and implement which requests are reviewable (sudo, `danger`, `critical` are not)
- [x] 1.2 Test and implement the reviewer prompt (what is in it, what is not, size limits) and the answer parser
- [x] 1.3 Test and implement the session reviewer: failures escalate, the two limits

## 2. Gate

- [x] 2.1 Test and implement the reviewer stage of `prompt()`: allow, escalate to the user, headless denial, MCP, hook first
- [x] 2.2 Test and implement the audit record and the `reviewer` decision source

## 3. Core, tools and CLI

- [x] 3.1 Add the `approval_reviewed` event, `reviewerReason` and the tool call id on a request
- [x] 3.2 Test and implement the denial text of the bash tool and the MCP wrapper
- [x] 3.3 Test and add the `approvalReviewer` config key; build the reviewer in the factory with the `utilityModel`
- [x] 3.4 Add `askModel` to core for the model call: `ai` is bundled into the CLI and `generateText` breaks that bundle

## 4. TUI

- [x] 4.1 Test and implement the mark on a reviewer-approved tool line, the reason in the prompt and the stop notice

## 5. Wrap-up

- [x] 5.1 Update `README.md` and `docs/bash-command-policy.md`
- [x] 5.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`, one run with a real model
