# Triage Labels

The skills speak in terms of canonical triage roles. This file maps those roles to the Label strings used in this repo's Burnlite Project. Burnlite creates a Label the first time it is added and matches names regardless of case.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | _(not used)_         | Burnlite has no reporter workflow: ask the user directly and keep `needs-triage` |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned; the Task is also closed as Not planned |
| `bug`                      | `bug`                | Category: something is broken            |
| `enhancement`              | `enhancement`        | Category: new feature or improvement     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding Label string from this table.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use. `npx burnlite init` writes this file only when it is missing, so your edits stay.
