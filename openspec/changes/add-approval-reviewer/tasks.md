## 1. Reviewer rules

- [ ] 1.1 Test and implement which requests are reviewable (sudo, `danger`, `critical` are not)
- [ ] 1.2 Test and implement the reviewer prompt (what is in it, what is not, size limits) and the answer parser
- [ ] 1.3 Test and implement the session reviewer: failures escalate, the two limits

## 2. Gate

- [ ] 2.1 Test and implement the reviewer stage of `prompt()`: allow, escalate to the user, headless denial, MCP, hook first
- [ ] 2.2 Test and implement the audit record and the `reviewer` decision source

## 3. Core, tools and CLI

- [ ] 3.1 Add the `approval_reviewed` event, `reviewerReason` and the tool call id on a request
- [ ] 3.2 Test and implement the denial text of the bash tool and the MCP wrapper
- [ ] 3.3 Test and add the `approvalReviewer` config key; build the reviewer in the factory with the `utilityModel`

## 4. TUI

- [ ] 4.1 Test and implement the mark on a reviewer-approved tool line, the reason in the prompt and the stop notice

## 5. Wrap-up

- [ ] 5.1 Update `README.md` and `docs/bash-command-policy.md`
- [ ] 5.2 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`, one run with a real model
