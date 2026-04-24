## Context

Commands are structurally almost identical to skills: same discovery tiers, same frontmatter approach, same Claude-compat pattern. They differ in invocation (user types a `/`) and in who expands them (client-side, before the request reaches the server). This design records the small set of decisions distinct from `add-skills`.

## Goals / Non-Goals

**Goals:**

- Claude-compat on file layout (`.claude/commands/<name>.md`) and on the common `$ARGUMENTS` / `$1` placeholder style.
- Expansion is pure string substitution — deterministic, no model involvement.
- Built-ins never conflict with user templates; the TUI checks built-in names first.

**Non-Goals:**

- Commands registering tools or modifying the model. They produce a user message, nothing more.
- Templating beyond simple placeholders (no loops, conditionals, includes).
- Command arguments typed / validated. `$1` et al. are whitespace-split; the template author decides how to use them.

## Decisions

### D1. Expansion is client-side, always

**Decision:** `CommandRegistry.expand(name, args)` runs in the TUI or CLI before any HTTP call. The server never sees an un-expanded `/<name>` and never loads command bodies during a run.

**Why:** `spec.md` §10.4 explicitly specifies this. It keeps the server dumb and makes commands work identically in any consumer: TUI, `chimera run`, third-party SDK users all expand the same way.

**Cost:** Server-side `listCommands` has to load bodies to serve introspection, even though it never expands — acceptable since it's a small, cold path.

### D2. Built-in names shadow user templates

**Decision:** When a user types `/help`, the TUI handles it even if `.chimera/commands/help.md` exists. A warning is logged once at session start if a user template's name collides with a built-in.

**Why:** Built-ins are part of the product contract. Letting users override them would create confusing bug reports.

**Alternative considered:** Prefix built-ins (`//help` or `.help`). Rejected — it breaks Claude-compat muscle memory.

### D3. Placeholder grammar is strict and small

**Decision:** Exactly `$ARGUMENTS`, `$1` through `$9`, `$CWD`, `$DATE`. Match by literal (regex boundary) and substitute. Anything else is passed through verbatim.

**Why:** `spec.md` §10.2 says "Unknown placeholders left as-is (so `$PATH` in shell snippets survives)". That property breaks the moment we support generic variable expansion. Strict grammar keeps it clean.

**Details:** `$1` greedily matches `$1` only, not `$10`. `$ARGUMENTS` is substituted before numbered positionals so e.g. a template containing both works.

### D4. Unknown templates fall through to a "did you mean" hint

**Decision:** If `/<name>` is neither built-in nor a loaded user template, the TUI shows a fuzzy-match hint naming the 1–3 closest template names. The input is NOT sent to the model.

**Why:** Typos should be caught cheaply. Sending `/foo` as a literal model message is almost never what the user intended.

### D5. `chimera run --command foo --args "bar"` is a one-shot convenience

**Decision:** It is exactly equivalent to `chimera run "$(chimera commands expand foo --args bar)"` — i.e. the template is expanded, then the expanded text is sent as the first user message. No special session metadata, no hook for the model to know it was invoked via a command.

**Why:** Commands are pure templates; there is nothing interesting to tell the model beyond the expanded text.

## Risks / Trade-offs

- **[Shell-snippet-style placeholders (`$PATH`) leak]** — mitigated by D3's strict grammar.
- **[Server and client registries can drift]** — both load from disk at session start; we do not support mid-session reload. Documented.
- **[Large command trees slow session start]** — same bound as skills (git-root-terminated walk, small file reads).

## Migration Plan

Additive. Users upgrading from MVP get `.claude/commands/` trees auto-discovered. Opt out via `--no-claude-compat` or `commands.enabled: false` in config.

## Open Questions

- Should expansion support a `$STDIN` placeholder for `chimera run --stdin --command foo`? Proposed: **no** — if the user pipes stdin, they should write the template to use `$ARGUMENTS` and pass `--args "$(cat)"`. Revisit if users ask.
- Do we support argument parsing that respects quotes (so `/review "a b"` gets `$1 = "a b"` rather than `"a` and `b"`)? Proposed: **yes**, minimal shell-style split (treat balanced double-quotes as a group). Implement via a small helper rather than taking a dependency.
