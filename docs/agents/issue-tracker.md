# Issue tracker: Burnlite

Issues, specs and maps for this repo live in Burnlite, in the Project with key `CHIM`. Use the Burnlite tools for all operations.

_Written by `npx burnlite init --project CHIM`; re-running it replaces this file. Burnlite tracker doc 3, following the `setup-matt-pocock-skills` templates (`issue-tracker-github.md`, `issue-tracker-local.md`) as installed on 2026-11-03, `issue-tracker-github.md` sha256 `6fdb3e9b00b7`._

**Calling the tools:** each operation below names a Burnlite MCP tool and its arguments. If the Burnlite MCP tools aren't connected, run `npx burnlite <tool-with-dashes> --json` instead (`list_tasks` → `npx burnlite list-tasks --json`; arguments become flags such as `--task-id`, and `--<flag>-file <path>` reads long text from a file).

## Conventions

- **Items and Keys**: an issue is a **Task**; a group of issues (a map, a spec, a parent issue) is a **Milestone**. Every Task and Milestone has a Key like `CHIM-42` that never changes. Every tool takes a Key or an id, and returns the Key and the item's URL, `/CHIM-42`.
- **Project**: pass `projectId: "CHIM"` to tools that take a Project.
- **Kinds**: a **Work task** is implementation work and needs `size` and `uncertaintyLevel` (see **Estimating Work tasks**). A **Meta task** (`kind: "meta"`) is planning or a decision ticket and takes no estimate.
- **Create an issue**: `create_task` with `projectId`, `taskName`, `milestoneId` (optional), `kind`, `size` and `uncertaintyLevel` (Work tasks only), `description` (markdown: what and why), `plan` (optional, markdown: how), `labels` and `blockers`. To create several that block each other, use `create_tasks`: each item takes the same fields plus a `ref` that other items' `blockers` can name; the batch is saved all or nothing, and Keys come back in item order.
- **Read an issue**: `get_task` with `taskId`. It returns the Description, Plan, Labels, Claim, Blockers and the Tasks it blocks with their states, Checklist items, Notes, and the text `revision`.
- **List issues**: `list_tasks` with `projectId` and any of `milestoneId`, `kind`, `state` (`open`, the default; `closed`; `any`), `labels` (every one must match), `unlabeled: true`, `claimed_by`, `frontier: true` and `updated_since` (an ISO 8601 timestamp: only Tasks whose `updatedAt` is after it). Rows come in Milestone order, then Task order; Keys are numbered in creation order, so sort by `number` for oldest first.
- **Make an issue part of a parent**: the parent is a Milestone. Create the Task with `milestoneId`, or move it with `update_task` and `milestoneId`. `create_milestone` (`projectId`, `name`, `description`, `labels`) makes the parent; `get_milestone` (`milestoneId`) reads it with its Notes and Task rows; `list_milestones` (`projectId`, `labels`, `state`) finds them.
- **Blocking**: Burnlite's native **Blockers**, between Tasks in this Project. Set them on create (`blockers`, or refs in `create_tasks`), or later with `update_task` `add_blockers` / `remove_blockers`. An edge that would make a loop fails with `cycle`, naming the loop, and nothing is saved. A Task is unblocked when every Blocker is closed, for either reason.
- **Count open blockers**: a `list_tasks` row has `blocked` and `openBlockers` (Keys); `get_task` lists each Blocker with its `state`.
- **Comment on an issue**: `create_note` with `taskId` (or `milestoneId` for a Milestone), `content` (markdown) and `holder`.
- **Apply / remove labels**: `update_task` (or `update_milestone`) with `add_labels` / `remove_labels`. A Label is created on first use and matched regardless of case; the result lists the Project's Labels, so reuse an existing one rather than add a near-duplicate. `list_labels` lists them.
- **Close**: `close_task` with `taskId`, `reason` (`completed`, the default, or `not_planned`), `summary` (one line, at most 200 characters, no line breaks) and `note` (the explanation, saved with the close). Never post the explanation as a separate Note first. Closing releases the Claim. `reopen_task` undoes a close.
- **Claim**: `claim_task` with `taskId` and `holder`, before any other work on the Task. If another holder has it, the call fails with `already_claimed`, naming the holder: take another Task. `release_claim` hands a Claim back.
- **Holder name**: send the same `holder` on every call that takes one (claims, Notes, closes, text edits). Use the first that applies: your engram identity (`ENGRAM_IDENTITY`), else your Legato task id (`LEGATO_TASK_ID`), else your coding agent's own name. The CLI fills it from the environment.
- **Editing text**: edit a Description or Plan from a fresh `get_task` / `get_milestone`, and send its `revision` as `expected_revision` to `update_task` / `update_milestone`. On `stale_write`, someone changed it since: the error returns the current text and revision, so re-apply your edit to that text and retry. Never resend your old text as it was.
- **Refer to items by Key** (`CHIM-42`) in commits, PRs and Notes. In Burnlite text, link an item by its name: `[the Task's name](/CHIM-42)`.
- **Errors** come back as `isError` with a `code`: `not_found`, `validation` (fix the arguments), `stale_write`, `cycle`, `already_claimed`, `conflict`, `insufficient_scope` (the user must reconnect with the scope it names).

The user may run sessions in parallel, so expect other sessions to change the tracker at the same time: claim before you work, and edit text from a fresh read.

## Stages

Milestones and Tasks can carry a stage: Idea, Exploring, Ready, Building, Done or Dropped. Stages run themselves:

- The Project's **Stage mapping** moves an item forward when a mapped Label is added. With the Wayfinder mapping, `wayfinder:map` gives Exploring, `ready-for-agent` gives Ready, `needs-triage` gives Idea and `ready-for-human` gives Ready, so the Labels below already move maps, specs and tickets. `get_project` shows the mapping as `stageMapping`.
- Building and Done follow from Claims and closes, and closing gives Done or Dropped.
- So don't set `stage` unless the user asks. When they do, `update_milestone` and `update_task` take `stage` (`idea`, `exploring`, `ready` or `building`); Done and Dropped come only from closing.
- The Frontier skips Tasks staged Idea and Exploring. `claim_task` still claims one, and its result says it isn't ready (`notReady`).
- `get_attention` with `projectId` lists what waits on the owner, most urgent first. Use it when the user asks what needs them.

## Pull requests as a triage surface

**PRs as a request surface: no.** Pull requests stay on GitHub; Burnlite triage covers Tasks only.

## When a skill says "publish to the issue tracker"

A spec or a group of tickets is a Milestone; a single ticket is a Task. See **Specs and tickets** below.

## When a skill says "fetch the relevant ticket"

`get_task` for a Task Key; `get_milestone` for a Milestone Key (a spec or a map). A `/CHIM-42` URL's last part is the Key. State its name before starting.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a Milestone with **Meta tasks** as tickets.

- **Map**: a Milestone labelled `wayfinder:map`: `create_milestone` with `projectId`, `name`, `labels: ["wayfinder:map"]` and a `description` holding the Destination, Notes, Not yet specified, and an Out of scope section for work ruled out that never had a ticket. Find maps with `list_milestones` and `labels: ["wayfinder:map"]`. Load one with `get_milestone`: its Description, its built **Decisions so far** (`decisionsSoFar`) and **Out of scope** (`outOfScope`) lists, and summary rows for its tickets.
- **Decisions so far is built, not written**: it is the map's Completed Meta tasks, oldest close first, each as `[name](/CHIM-n): summary`. Never write Decisions so far, or out-of-scope tickets, into the Description.
- **Child ticket**: a Meta task in the map Milestone (`kind: "meta"`, `milestoneId: <map Key>`), with the question as its `description` and one Label `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). No size, no uncertainty, no triage Labels.
- **Create and wire tickets**: one `create_tasks` call with every ticket, in map order, each with a `ref`; an item's `blockers` name other items' refs (or existing Keys). This replaces upstream's second wiring pass. For cross-references in a ticket's text, use the Keys the call returns: `update_task` with `description` and `expected_revision`. Edges found later: `update_task` with `add_blockers`.
- **Blocking**: see **Blocking** under Conventions.
- **Frontier query**: `list_tasks` with `projectId`, `milestoneId: <map Key>` and `frontier: true` (open, unclaimed, every Blocker closed, not staged Idea or Exploring). The first row wins.
- **Claim**: `claim_task` with `taskId` and your `holder` (see **Holder name**), the session's first write. On `already_claimed`, take the next frontier row.
- **Resolve**: `close_task` with `reason: "completed"`, a `summary` (the one-line gist of the answer, which becomes its Decisions so far line) and a `note` (the answer in full, with links to any assets). Nothing is appended to the map.
- **Rule out of scope**: `close_task` with `reason: "not_planned"` and a `summary` saying what was ruled out and why. It appears in the map's built Out of scope list, never in Decisions so far.
- **Graduate fog**: create the new tickets as above, then edit the map's Description (see **Editing text**) to clear the graduated patch from Not yet specified.
- **Invalidated tickets**: change them with `update_task`, or close them with `reason: "not_planned"` and a `summary`.
- **Finish the map**: when its destination is a spec, to-spec closes it (see **Specs and tickets**). When it is a decision or a change made in place, the session that resolves the last ticket closes it: `create_note` with `milestoneId: <map Key>` saying where the destination is, then `close_milestone` with `milestoneId: <map Key>` and `reason: "completed"`. Closing moves the map to Done.

## Specs and tickets

A triage role such as `ready-for-agent` means the Label `triage-labels.md` maps it to.

- **to-spec**: publish the spec as a Milestone: `create_milestone` with `projectId`, the spec's name, the spec as `description`, and `labels: ["ready-for-agent"]`. Then close the source map: `create_note` with `milestoneId: <map Key>` linking the spec (`[the spec's name](/CHIM-n)`), and `close_milestone` with `milestoneId: <map Key>` and `reason: "completed"`.
- **to-tickets**: publish the tickets as Work tasks in the source Milestone (the spec or map), in dependency order, preferably in one `create_tasks` call: each item with a `ref`, `milestoneId`, `taskName`, `description` (the ticket body), `size`, `uncertaintyLevel`, `labels: ["ready-for-agent"]`, and `blockers` naming other items' refs. Blockers are native, so leave the "Blocked by" section out of the body.
  - **No source spec or map**: first `create_milestone` named for the work, with the summary a parent issue would have held as its `description`, then file the Tasks under it.
  - **Source is a Task**: file the tickets in that Task's Milestone, and start each `description` with `Part of [its name](/CHIM-n)`.
  - Do not close or change the source Milestone or Task.
- **implement**: fetch the ticket (`get_task`, or `get_milestone` for a whole spec), then `claim_task`. Follow its Plan, tick each Checklist item with `update_checklist_item` (`checklistItemId`, `done: true`), and when the work is committed, `close_task` with `reason: "completed"` and a one-line `summary`.

## Estimating Work tasks

Every Work task needs both `size` and `uncertaintyLevel`. Show them in the breakdown you present to the user.

- **Size**: `Small` (0.5 day), `Medium` (1 day), `Large` (3 days), `X-Large` (5 days).
- **Uncertainty**: how unsure the estimate is, not how hard the work is: `Low`, `Medium`, `High`, `Extreme`.
- **They are slicing signals.** An `X-Large` or `Extreme` Task should usually be split before it is filed: into thinner vertical slices, or a Meta task that settles the unknown first.

## Triage

Used by `/triage`. The roles are Labels; `triage-labels.md` maps each role to its Label.

- **Category and state**: `update_task` with `add_labels` / `remove_labels`, so each Task carries exactly one category Label and one state Label.
- **Show what needs attention**: the **Unlabeled** bucket is `list_tasks` with `projectId` and `unlabeled: true`; the **needs-triage** bucket is `list_tasks` with `labels: ["needs-triage"]`. Sort each by `number`, oldest first. There is no third bucket.
- **Triage notes and agent briefs**: `create_note` on the Task, starting with the AI disclaimer the skill gives.
- **`needs-info` is not supported**: Burnlite has no reporters to wait on. Ask the user directly; until they answer, the Task stays `needs-triage`.
- **`wontfix`**: `update_task` with `add_labels: ["wontfix"]` (and remove the old state Label), then `close_task` with `reason: "not_planned"`, a `summary`, and the explanation as its `note`.
- **Pull requests** are not triaged here (see **Pull requests as a triage surface**).
