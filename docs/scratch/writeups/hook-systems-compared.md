# Hook systems compared: Claude Code, Legato, OpenCode, Pi

A survey of how four coding-adjacent agents expose lifecycle extensibility, with an eye toward picking a model for Chimera. All four call them "hooks" or "extension events," but they sit at very different points on the *external-vs-in-process* and *observer-vs-mutator* axes.

| | Claude Code | Legato | OpenCode | Pi |
|---|---|---|---|---|
| **Mechanism** | External shell / HTTP / sub-agent / prompt | External shell scripts | In-process TS plugins (Effect) | In-process TS extensions (jiti) |
| **Config surface** | `settings.json` (5 layers) | CLI install command + adapters | npm packages / local files | TS files loaded at startup |
| **Trust boundary** | Process boundary; trust dialog | Process boundary; user-installed | Same process as agent | Same process as agent |
| **Event count** | 27 events, 4 hook types | 5–7 events (Claude/Staccato adapters) | ~15+ hook points | 19+ events |
| **Can block actions?** | Yes (exit code 2 / `decision: block`) | No (fire-and-forget) | Yes (`{block: true}`) | Yes (`{block, reason}`) |
| **Can mutate inputs/outputs?** | Yes (PreToolUse modify, UserPromptSubmit context inject) | No | Yes | Yes |
| **Per-project + global** | Yes (5 sources, layered priority) | Yes (Claude per-project, Staccato global) | No (plugin scope = process) | No (process-level) |

---

## 1. Claude Code — the maximalist external-process model

**Configuration.** Hooks are declared in `settings.json` (across user / project / managed / policy / `--settings` flag layers). Each entry is `{matcher, hooks: [{type, command|prompt|url, ...}]}`. The matcher uses permission-rule syntax (e.g. `"Bash(git *)"`).

**Events.** 27 of them, covering basically every lifecycle point: `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `PreCompact`/`PostCompact`, `SubagentStart`/`SubagentStop`, `SessionStart`/`SessionEnd`, `ConfigChange`, `InstructionsLoaded`, `WorktreeCreate`/`Remove`, `CwdChanged`, `FileChanged`, `TaskCreated`/`Completed`, `Elicitation`, etc.

**Hook types.** Four:
1. `command` — shell process. Receives JSON on stdin, returns either an exit code (0 = ok, 2 = block) or JSON on stdout.
2. `prompt` — runs an LLM evaluation with `$ARGUMENTS` substitution; the LLM decides allow/block.
3. `http` — POST to a URL. SSRF guard blocks private/link-local/metadata IPs but allows loopback for local policy servers.
4. `agent` — spawns a sub-agent verifier with a prompt.

**Protocol.** Stdin JSON carries the event payload (tool name, args, transcript, session metadata). Stdout JSON can include `decision: "block"`, `reason`, `additionalContext`, `hookSpecificOutput`. Exit code 2 is a terse block; any non-zero non-2 surfaces as an error.

**Sources merged at runtime.** Settings files + plugin hooks + skill-scoped hooks + registered callback hooks + session hooks.

**Safety controls.** `disableAllHooks`, `allowManagedHooksOnly`, trust dialog before first run; `ConfigChange` hooks against policy settings cannot block (forced `blocked: false`).

**Pros**
- Language-agnostic (any executable). Trivial to write a hook in bash, Python, Go.
- Strong isolation: hook crashes / loops don't take down the agent process.
- Extremely broad coverage — almost any behavior is interceptable.
- Layered config (user / project / managed) gives ops + per-repo + per-user customization without conflict.
- Multiple hook *types* let the same event be served by a fast shell script in one repo and an LLM judge in another.

**Cons**
- Process-spawn cost on every gated event. `PreToolUse` firing on every tool call adds latency.
- JSON-over-stdio protocol is verbose; small bugs (forgotten flush, stderr noise) silently break hooks.
- 27 events × 4 types × 5 config sources = a *lot* of surface area to document, debug, and secure.
- HTTP hook needs SSRF guard, env-var interpolation rules, header policy — non-trivial to get right.

---

## 2. Legato — the minimalist adapter-observer model

Legato is a kanban-style task tracker that *integrates with* coding agents (Claude Code, Staccato) rather than being one. Its "hooks" are how it observes those external tools, not how it extends itself.

**Configuration.** No declarative file. CLI command:
```bash
legato hooks install --tool claude-code
```
Each tool has a Go `AIToolAdapter` implementation (`internal/service/adapter.go:9-18`) that knows how to write the hook scripts into that tool's expected location.

**Events.** Tiny, hand-picked set:
- Claude Code: `UserPromptSubmit`, `PostToolUse`, `PermissionRequest`, `Stop`, `SessionEnd` — used to flip a card's activity state between *working* / *waiting* / *idle*.
- Staccato: `post-pr-create`, `post-pr-view` — used to auto-link branches/repos to tasks.

**Protocol.** Hooks are `#!/bin/sh` scripts that *call back into the legato CLI*:
```sh
[ -z "$LEGATO_TASK_ID" ] && exit 0
legato agent state "$LEGATO_TASK_ID" --activity working
exit 0
```
Communication is via env vars (`LEGATO_TASK_ID` injected when legato spawns the agent in a tmux pane) and CLI args. The CLI handler then writes SQLite + broadcasts IPC to running legato TUI instances.

**Control flow.** Strictly fire-and-forget. Hooks cannot block, cancel, or mutate anything. They observe and report.

**Discovery.** Claude Code hooks are merged into `.claude/settings.json` non-destructively (preserving existing user hooks). Staccato hooks go to `~/.config/staccato/hooks/<event>/`.

**Pros**
- Almost no design surface — easy to reason about and test.
- Robust to hook failure: a broken hook just means a stale activity badge, not a wedged agent.
- Plays well with whatever the *target* tool's hook system already is. Legato doesn't need to define its own protocol.
- The adapter pattern (one Go interface per supported tool) is a clean way to pick up new agents without churning core code.

**Cons**
- Not actually a general-purpose extension system. If you want to *change* agent behavior, this model gives you nothing.
- The hook's only output channel is "shell out to the host's CLI, which writes to a DB." That's fine for state tracking, fatal for anything performance-sensitive.
- Adapter-per-tool means N hook implementations for N supported agents — maintenance scales linearly.

This is the right model when your project *consumes* an agent's hooks rather than *exposing* its own.

---

## 3. OpenCode — in-process plugin hooks (Effect / TS)

**Configuration.** Plugins are npm packages or local TS files; each plugin registers callbacks against named hook points. No declarative JSON — the plugin module *is* the config.

**Events.** Roughly 15+, grouped:
- Chat: `chat.params` (mutate temperature/topP), `chat.headers` (inject HTTP headers), `chat.message`
- Tool: `tool.execute.before`, `tool.execute.after`, `tool.definition` (modify tool schemas)
- System: `experimental.chat.system.transform`, `experimental.chat.messages.transform`
- Permission: `permission.ask`
- Shell: `shell.env` (inject env vars)
- Auth / provider: OAuth flow customization, dynamic provider/model registration

**Protocol.** Plain function callbacks running in the agent's Effect runtime. A `tool.execute.before` callback receives the tool call and can return a mutated version or throw to abort. Same process, same memory — no serialization.

**Pros**
- Zero per-call overhead. A tool-execution hook is just a function call.
- Hooks can return rich, typed values; refactors catch mismatches at compile time.
- Plugins can do more than hooks — they also register providers, tools, and commands. The hook system is one part of a broader plugin API.
- Plugin authors use the same Effect primitives the core uses, so error handling, cancellation, and concurrency compose naturally.

**Cons**
- Requires plugin authors to write Effect-style TS. Non-trivial learning curve.
- A misbehaving plugin (crash, infinite loop, leaked Effect fiber) takes the agent process down. No isolation.
- Several hook points are still `experimental.*` — API instability.
- No layered config (user vs project vs managed). Plugin set is process-wide.
- Can only be written in TypeScript / JavaScript.

---

## 4. Pi — in-process extension events with mutation + blocking

Pi's extension API is the most *event-rich* of the in-process designs.

**Configuration.** TS extension files loaded at startup via `jiti` (dynamic module loader). No code review, no signature verification, no capability sandbox.

**Events.** 19+ across the lifecycle, including `beforeToolCall` / `afterToolCall`, `tool_call` permission gate, `user_bash`, plus events for prompts, providers, UI, sessions.

**Protocol.** Function callbacks. Each event has a typed payload and a typed return shape. `beforeToolCall` can return `{ block: true, reason }` *or* a mutated argument set. `afterToolCall` can rewrite the result content, details, or error flag. The `tool_call` event is the *only* permission mechanism — without an extension that intercepts it, all tool calls execute unconditionally.

**Pros**
- The breadth of mutable hook points exceeds Claude Code's, despite Pi being a much smaller project.
- Extensions can implement features the core lacks (e.g., a permission system) entirely from outside.
- Same in-process performance story as OpenCode.

**Cons**
- No process isolation — same blast-radius problem as OpenCode, plus *more* hook points to misuse.
- No capability system. Any extension can do anything; an extension you trusted for one purpose can monkey-patch any other event.
- Permission-as-extension is dangerous: forget to load the gating extension and the agent runs everything unchecked.
- TS-only.

---

## How to pick

The decision largely reduces to two questions.

### Q1: Should hooks be in-process or external?

**External (Claude Code / Legato style)** wins on:
- Language flexibility (write hooks in bash, Python, Go, whatever).
- Crash isolation — a bad hook can't take down the agent.
- Multi-tenant safety — easier to defend against a malicious project-level hook than against a malicious in-process plugin.
- Layered config (user / project / managed) is natural, because hooks are external resources you can scope.

**In-process (OpenCode / Pi style)** wins on:
- Latency — no fork/exec per gated event. Matters if you want a hook on *every* tool call.
- Type safety — typed payloads/returns catch mistakes at build time.
- Rich return values — hooks can return structured objects without serialization tax.
- Convenient for plugin systems that *also* register tools/providers/commands, since those need in-process integration anyway.

### Q2: Should hooks be observers or mutators?

**Observers** (Legato): simple, robust, hard to misuse. Sufficient for telemetry, dashboards, off-process side effects.

**Mutators** (Claude Code, OpenCode, Pi): give users real customization power — block tools, inject context, rewrite results — at the cost of needing a permission/trust model.

A middle ground — observers by default, with a separately-gated set of mutating events — is what Claude Code effectively does (`disableAllHooks` / `allowManagedHooksOnly` / trust dialog).

---

## Recommendation for Chimera

Given Chimera's stated architecture (TUI ↔ HTTP+SSE ↔ server, with permissions already as a first-class subsystem in `packages/permissions`), the **Claude Code external-process model is the closest fit**. Reasons:

1. **Permissions already exist as a separate package.** Hooks would slot in next to them as another externally-defined gate, rather than inverting the architecture by living in-process the way Pi/OpenCode require.
2. **HTTP+SSE boundary is already a process boundary.** Adding a JSON-stdin hook protocol doesn't introduce a new isolation model; it reuses the one that already exists.
3. **Layered config maps cleanly onto the project.** User-global + per-project hooks are easy to reason about with the existing settings story.
4. **Avoids locking hook authors into TS.** Anyone who writes a Chimera hook can ship a Go binary, a shell one-liner, or a Python script.

A plausible MVP scope, sequenced by value:

| Stage | Events | Hook types |
|---|---|---|
| MVP | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` | `command` only |
| v2 | + `PermissionRequest`, `SessionStart`, `SessionEnd` | + `http` |
| v3 | + `PreCompact`, `SubagentStart`, `SubagentStop` | + `prompt` (LLM judge) |

Skip Claude Code's full 27-event surface for now — most of those events exist to support features Chimera doesn't have yet (worktrees, teammates, instructions auto-loading). Skip the `agent` hook type entirely until subagents are stable. Lift Claude Code's `matcher` syntax (it already lines up with the permission-rule syntax in `packages/permissions`), and copy its `disableAllHooks` + `allowManagedHooksOnly` knobs from day one — it is much easier to ship those now than to retrofit them after a security incident.

The one piece worth stealing from OpenCode/Pi is the **idea** of `tool.definition` hooks (let a hook rewrite a tool's schema before it's exposed to the model). That's hard to do via stdin JSON because the schema changes have to be visible *before* tool calls, but it's worth keeping on the v3+ list — it's the cleanest way to let users add per-project guardrails to existing tools without forking them.

---

## Hooks + plugins together: drawing the line

Once user-defined tools enter the picture, hooks alone can't carry the load — there's no way to register a new tool from a shell script in a way that's visible to the model's tool-schema list at session start. So Chimera ends up with both subsystems. Claude Code itself runs both, so this is a well-trodden combination; the goal is to keep their responsibilities cleanly disjoint.

**The division of labour:**

- **Plugins shape the *menu* of capabilities.** A plugin contributes new tools, new LLM providers, new slash commands, new TUI surfaces — anything that has to be visible to the agent before a session is fully assembled. Plugins are in-process TS, loaded at session start in the *server* process (the TUI stays insulated).
- **Hooks gate *invocations* and observe *lifecycle events*.** A hook decides whether a particular tool call runs, injects context into a prompt, fires on session start/end, or pipes events into telemetry. Hooks remain external processes with stdin-JSON / exit-code protocol, layered across user / project / managed config.

**The single overlap — tool-call interception — is resolved by precedence:** hooks run *outside* the plugin-supplied tool boundary. A plugin defines `deploy_to_prod`; a hook decides whether *this particular* `deploy_to_prod` call is allowed right now. Plugins should not have a "before tool call" callback that competes with `PreToolUse`; if a plugin author wants that, they ship a hook bundled with the plugin.

**Plugins as the packaging unit.** Adopt Claude Code's pattern of letting a plugin distribute its own hooks. A vendor publishes "the X plugin" as one bundle (tools + commands + bundled hooks) rather than asking users to wire up settings by hand. Standalone hooks remain available for one-off cases, but plugins are the natural distribution unit once vendors are involved.

**Knobs that become load-bearing once plugins exist:**

| Concern | Where it lives | Notes |
|---|---|---|
| Isolation | Server process only; TUI never loads plugins | Worker-thread isolation is a future option, not MVP |
| Loading time | Session start; tools registered before first model call | No mid-session tool registration — keeps the model's worldview stable |
| Trust | `disableAllPlugins`, `allowManagedPluginsOnly`, signed-plugin manifest | Ship from day one — hard to retrofit |
| Crash policy | A plugin throwing on registration disables that plugin, not the session | A plugin throwing inside a tool call propagates as a tool error |
| Hot reload | Out of scope for MVP | Restart the server to pick up plugin changes |
| Capability declaration | Plugin manifest declares which subsystems it touches (tools / providers / commands / hooks) | Lets `allowManagedPluginsOnly` be evaluated before TS code runs |

**Where the line gets blurry, and how to handle it:**

- *"Can a hook register a tool?"* No. If you find yourself wanting that, the right answer is a plugin. Resist the temptation to add `RegisterTool` as a 28th event — it bypasses the plugin trust boundary.
- *"Can a plugin replace the permission system?"* No. Permissions stay in `packages/permissions` and are evaluated outside any plugin code. A plugin that wants to influence permissions ships a hook on `PermissionRequest`.
- *"Should plugins be able to call hooks?"* Yes — a plugin's bundled hooks fire through the same dispatch path as user-defined hooks. There's no separate "plugin hook" type.

---

## File-and-config vs directory-based hooks

Two registration shapes are on the table. Both are working systems in the wild, and the choice mostly comes down to which complexity you'd rather pay.

### Option A — config-driven (Claude Code shape)

Hooks are entries in `settings.json`; the script lives wherever you like and is referenced by path:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(git push *)",
        "hooks": [
          { "type": "command", "command": "/abs/path/to/guard.sh", "timeout": 5000 }
        ]
      }
    ]
  }
}
```

**Pros**
- All hooks visible in one place. `cat settings.json | jq .hooks` is the inventory.
- Rich metadata is natural: matchers, timeouts, env, hook type (`command` / `http` / `prompt` / `agent`), per-hook `disable` flag.
- Single source of truth for policy: `disableAllHooks`, `allowManagedHooksOnly` live next to the entries they govern.
- Non-shell hook types (`http`, `prompt`, `agent`) have a sensible home — they don't have a script file to "drop" anywhere.
- Layering across user / project / managed is obvious, since the layering already exists for the rest of settings.

**Cons**
- Two-step setup for the simple case: write the script *and* edit JSON.
- JSON is awkward to hand-edit; one bad comma breaks unrelated hooks.
- Discovery is poor for users unfamiliar with the settings file. There's no `ls` you can run that tells you what hooks exist.
- Disabling a hook means commenting JSON, which JSON doesn't support — you end up with `"_disabled_hooks": [...]` workarounds.

### Option B — directory-driven (Staccato / git-hooks / systemd-drop-in shape)

Hooks are files placed in a conventional path; presence enables them, filename derives the name, the parent directory derives the event:

```
.chimera/hooks/
├── PreToolUse/
│   ├── 10-git-push-guard.sh    # runs first (lexicographic)
│   └── 20-audit-log.sh
├── PostToolUse/
│   └── notify-on-edit.sh
└── UserPromptSubmit/
    └── inject-cwd.sh
```

**Pros**
- Drop-in simplicity. Write a script, save it, done. No JSON edit.
- Self-documenting: `ls .chimera/hooks/PreToolUse/` *is* the inventory.
- Familiar pattern (git hooks, husky, systemd `*.d` directories, cron.d, post-receive). Users already know the shape.
- Disable by `chmod -x` or `mv script script.disabled`. Remove by `rm`. No JSON edits.
- Trivial to gitignore selectively (`.chimera/hooks/local/`).
- Symlinks work: `ln -s ~/.chimera/hooks/PreToolUse/audit.sh project-local-link`.

**Cons**
- No place for rich metadata. Matchers, timeouts, hook type — all have to either move *into the script* or live in a sidecar file, neither of which is great.
- Multiple non-`command` hook types (`http`, `prompt`, `agent`) don't fit the "drop a script in a directory" model. They need their own representation.
- Ordering becomes implicit (lexicographic by filename). Numeric prefixes (`10-`, `20-`) work but are a smell.
- Filesystem scanning at every session start. Cheap, but a real cost.
- Layering (user / project / managed) means *multiple* directories to walk, with merge rules that don't exist yet.
- `disableAllHooks` becomes a runtime check rather than a config-level off-switch.

### Hybrid — directory-driven with frontmatter, plus settings.json for policy

This is the option I'd actually pick for Chimera. It maps onto the precedent already set by skills/commands in the codebase (markdown with YAML frontmatter) and keeps the simple case simple:

```sh
#!/bin/sh
# ---
# event: PreToolUse
# matcher: Bash(git push *)
# timeout: 5000
# ---
exec /usr/local/bin/git-push-guard "$@"
```

Or even more minimally — if `event` is omitted, infer it from the parent directory name:

```
.chimera/hooks/PreToolUse/git-push-guard.sh   # event inferred, no frontmatter needed
```

`settings.json` then carries only **policy**, not registration:

```jsonc
{
  "hooks": {
    "disableAllHooks": false,
    "allowManagedHooksOnly": false,
    "trustedDirs": [".chimera/hooks", "~/.chimera/hooks"]
  }
}
```

Non-`command` hook types (`http`, `prompt`, `agent`) stay in `settings.json` because they have no script file to drop. So the rule is:

| Hook type | Where it lives |
|---|---|
| `command` | Directory-driven: `.chimera/hooks/<Event>/<name>.sh` (frontmatter optional) |
| `http`, `prompt`, `agent` | `settings.json` (under `hooks.<Event>[]`) |

**Why this fits Chimera specifically:**

1. **Consistency with existing extensibility.** Skills already use frontmatter-in-markdown (per `packages/skills`). Commands already load from a directory. A hook directory with optional frontmatter is the same pattern, not a new one.
2. **The 90% case is `command` hooks.** Optimize the common path. JSON entries are still there for the long tail, but most users never touch them.
3. **Layering is still cheap.** Walk `~/.chimera/hooks/`, then `.chimera/hooks/`, then managed paths. Same precedence rules as settings.json layers.
4. **`gh-style` discovery.** A `chimera hooks list` command can render the union of directory-discovered and config-declared hooks in one table — users don't need to know which storage shape they're looking at.

**The thing to be careful about:** make sure the directory and the JSON entries can't *both* register the same hook under the same name without an explicit precedence rule. Project-directory wins over user-directory wins over user-settings.json wins over managed, or some such — pick once and document it.
