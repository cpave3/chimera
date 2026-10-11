## Context

`DefaultPermissionGate.prompt()` is the one place where a request is put to
the user, for host `bash` commands (after the command policy) and for MCP
calls. Before it raises the request it fires the `PermissionRequest` hook and
applies the headless denial. Package 7 added `utilityModel`, and package 12
added the unsandboxed request, which also ends in `prompt()`.

## Goals / Non-Goals

**Goals:**

- Fewer prompts for work that is plainly inside the user's task.
- Headless runs that can go on where a prompt would have denied.
- No path by which the reviewer makes anything less safe than `autoApprove`
  already allows the user to choose.

**Non-Goals:**

- A reviewer for calls that need no approval. It is not a second policy.
- Remembering a reviewer decision as a rule.
- A separate reviewer model setting. `utilityModel` is the helper model.

## Decisions

### D1. The reviewer is a stage of `prompt()`

The order in `prompt()` becomes: `PermissionRequest` hook, reviewer,
headless denial, user. A hook that blocks still wins. Everything that never
reaches `prompt()` is untouched: auto-approval, allow rules, deny rules and
hard blocks. Alternative: a stage of the command policy pipeline. Rejected:
MCP calls do not go through the pipeline, and the reviewer needs the result
of the pipeline, not a place in it.

### D2. What always goes to the user

The gate, not the model, decides what the reviewer may see. A request with a
sudo finding, or with a risk finding of level `danger` or `critical`, skips
the reviewer. An unsandboxed request is reviewable: the approved plan sends
it through the reviewer, and the reviewer sees the agent's reason.

### D3. What the reviewer reads

- The tool call: the command, the working directory, the agent's reason; for
  an MCP call the server, the tool and its arguments.
- The policy findings.
- The user's messages: user-role text only. Tool results and assistant text
  are left out, and so are messages that Chimera wrote into the user role
  for a background agent.
- The project instruction files, as the system prompt loads them.

Each part has a size limit so that the request fits a small model. The first
user message and the newest ones are kept. The system text tells the model
that the tool call is data, and that doubt means `escalate`.

MCP arguments are not part of `PermissionRequest`, which goes to clients
without values. The gate hands them to the reviewer beside the request.

### D4. The answer

The reviewer answers with one JSON object, `{"decision", "reason"}`. The
parser takes the first JSON object in the reply. A reply with no such
object, a decision that is neither word, a provider error, or no answer in
30 seconds is `escalate` with a reason that says what failed. Failing closed
costs one prompt.

### D5. Limits

A session's reviewer counts escalations. Three in a row, or ten in all, and
it stops: later requests go to the user with no model call. An `allow`
resets the run of three. The numbers are constants. The decision that
reaches a limit says so on its event, and the TUI shows one notice.

### D6. Results

- `allow`: the gate allows the request, with decision source `reviewer`.
- `escalate`, user present: the request is raised with the reviewer's reason
  on it; the user's decision is recorded as now, with the review beside it.
- `escalate`, nobody to ask: denial with source `reviewer`. The tool result
  reads `denied by reviewer: <reason>`.

### D7. Telling clients

`approval_reviewed { requestId, callId?, decision, reason, stopped? }` is a
new event. The bash tool and the MCP wrapper put the SDK's tool call id on
the request; the factory turns it into the agent's `callId`. The TUI marks
the tool line with that `callId` when the decision is `allow`.

### D8. The model call lives in the CLI

`packages/permissions` holds the reviewer's rules: eligibility, limits, the
prompt text and the parser. It takes a `judge` function. The CLI factory
supplies one that asks the `utilityModel`, or the session model. So the
permissions package keeps no dependency on the AI SDK, and its tests need no
model.

The call itself is `askModel` in `packages/core`. `ai` is a devDependency of
the CLI and tsup inlines it; `generateText` pulls in a CommonJS module that
cannot run in that bundle, and the built binary did not start. Core has `ai`
as a real dependency.

## Risks / Trade-offs

- [The reviewer allows a harmful command] → off by default; sudo, `danger`
  and `critical` never reach it; every decision is in the audit log.
- [Injected text persuades the reviewer] → it reads no tool results and no
  assistant text. A command can still carry text; the system text calls it
  data.
- [A weak utility model escalates everything] → the limits stop it after
  three.
- [Each reviewed request costs a model call] → only requests that would
  prompt are reviewed, and the input is bounded.
