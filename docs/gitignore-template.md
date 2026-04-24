# Recommended .gitignore entries for Chimera

When a Chimera session writes to `~/.chimera/` it stores three kinds of state:

- `~/.chimera/sessions/` — per-session conversation snapshots.
- `~/.chimera/logs/` — structured JSON-line activity logs.
- `~/.chimera/permissions.json` — **never created in the home directory in MVP** (only `./.chimera/permissions.json` per-project is).
- `./.chimera/permissions.json` — project-scope permission rules. **You probably want to commit this**; it represents the rules your team has approved for this repo.

Recommended `.gitignore` entries for Chimera state that can be written inside a repo:

```
# Chimera transient state
.chimera/sessions/
.chimera/logs/

# NOTE: .chimera/permissions.json is *intentionally* committable — it records
# the set of shell commands your team has approved for this repo. Do not add
# it to .gitignore unless you specifically don't want to share those rules.
```

If you don't want any Chimera state in the repo at all, add the full directory:

```
.chimera/
```

— but then you lose the committable permission rules.
