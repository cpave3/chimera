## Why

A session that works on its own stops at each approval prompt, and a headless
run denies what it cannot ask about. Most of those requests are plainly part
of the task the user gave. A second, low-cost model can read the request
against what the user asked for and let the plain cases through, so the user
sees only the requests that need a person. Codex and Claude Code both have
such a stage.

## What Changes

- New config key `approvalReviewer: { "enabled": true }`. Off by default.
- With the reviewer on, a host command or an MCP call that would be put to
  the user goes to the `utilityModel` first (the session model when none is
  set). The reviewer answers `allow` or `escalate`, with a reason.
- `allow` runs the call. `escalate` opens the usual prompt, which shows the
  reviewer's reason. In a session with no user to ask, `escalate` is a
  denial and the model gets the reason.
- The reviewer reads the tool call, the policy findings, the user's messages
  and the project instructions. It does not read tool results or assistant
  text, so text that a tool brought in cannot argue for its own approval.
- Sudo commands and commands with a `danger` or `critical` risk finding never
  go to the reviewer. A deny rule or a hard block ends the request before
  the reviewer, as now.
- After 3 escalations in a row or 10 in a session, the reviewer stops for
  that session and requests go to the user as before.
- A reviewer that fails, times out or gives no usable answer counts as
  `escalate`.
- Each reviewer decision is in the decision audit log. A new
  `approval_reviewed` event carries it to clients, and the TUI marks a tool
  line that the reviewer approved.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `permissions`: the reviewer stage of the gate, its limits and its audit
  record.
- `agent-core`: the `approval_reviewed` event and the reviewer's reason on
  `permission_request`.
- `cli`: the `approvalReviewer` config key and the reviewer's model call.
- `tui`: the mark on a reviewer-approved tool line, the reason in the
  prompt, the notice when the reviewer stops.

## Impact

- `packages/core`: one event, two request fields, one decision source.
- `packages/permissions`: `reviewer.ts`, the gate, the audit record.
- `packages/tools`: the bash tool passes its tool call id and shows the
  reviewer's reason on a denial.
- `packages/cli`: config, the model call, wiring in the factory, the MCP
  tool wrapper.
- `packages/tui`: scrollback, permission modal.
- Additive for SDK clients: one new event and optional fields.
