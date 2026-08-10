# Host bash command policy

Chimera analyzes every agent-issued **host** bash command before execution. Sandbox-target commands keep the existing sandbox policy.

## Balanced mode

Balanced mode is the default. It preserves agent freedom by automatically running safe/caution commands, unfamiliar executables, builds, tests, package scripts, pipelines, and compound commands unless Chimera finds a concrete known danger.

```json
{
  "commandPolicy": {
    "hostBash": {
      "enabled": true,
      "mode": "balanced",
      "autoAllowThrough": "caution"
    }
  }
}
```

Balanced mode intervenes for:

- danger or critical classifier results;
- explicit unauthorized filesystem paths that Chimera can confidently identify;
- force pushes;
- recursive forced deletion;
- production-targeted mutating `kubectl` and Terraform commands;
- fork bombs and other deterministic scary-command rules.

Deterministic scary rules are hard blocks and do not show an approval prompt. Other concrete danger/path findings use the normal approval flow. When Chimera is about to prompt, it fires the existing synchronous `PermissionRequest` lifecycle hook before entering `waiting_for_permission`.

## Strict mode

Strict mode retains allow-by-proof behavior and also prompts when shell effects are unresolved or an analyzer fails:

```json
{
  "commandPolicy": {
    "hostBash": {
      "mode": "strict"
    }
  }
}
```

`autoAllowThrough` accepts `none`, `safe`, `caution`, or `danger`; critical is never automatically allowed. `enabled: false` explicitly restores legacy host permission behavior and prints a warning.

## Decision audit

Every automatic allow, rule decision, hard block, hook/headless denial, and user approval/rejection is appended to:

```text
~/.chimera/logs/permission-decisions.jsonl
```

Records include session/request IDs, cwd, full command, mode, decision source, findings, remembered status, feedback, and grants where applicable. The file and logs directory are user-only (`0600`/`0700`). Commands may contain secrets, so treat the audit as sensitive.

Review one persisted session with:

```bash
chimera sessions review-bash <session-id> --all
chimera sessions review-bash <session-id> --all --json
```

The deterministic extractor reads session `events.jsonl`, deduplicates bash calls from step snapshots, joins audit outcomes, and redacts likely credentials. The bundled `review-bash-policy` skill uses this command to identify false positives, false negatives, repeated approvals, and candidate regression tests. It never modifies policy automatically.

## Approval actions

For promptable findings, the TUI offers allow once, deny once, deny with feedback, and—when one narrow grant resolves all path findings—allow once plus a session read/write directory. The TUI queues concurrent parent and subagent permission requests.

## Limits

Balanced static analysis is intentionally an advisory safety net, not process confinement. Runtime data, scripts, approved commands, background processes, symlink races, and downloaded programs can behave differently after analysis. Use Chimera's sandbox when filesystem or process isolation is required.
