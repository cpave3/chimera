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
- fork bombs and other deterministic scary-command rules;
- every executable `sudo` invocation, including wrapped and compound commands.

Deterministic scary rules are hard blocks and do not show an approval prompt. Sudo is a deterministic but promptable elevation finding: it always uses the normal approval flow, even with `autoApprove: "host"`/`"all"` or a remembered allow rule. Other concrete danger/path findings also use the normal approval flow. When Chimera is about to prompt, it fires the existing synchronous `PermissionRequest` lifecycle hook before entering `waiting_for_permission`.

## Sudo authentication

After you allow a foreground sudo command in the owner-local interactive TUI, Chimera temporarily releases the terminal and runs `sudo -v` with inherited terminal input and output. Chimera displays an authentication banner and an explicit native prompt explaining that input is hidden and one press of Enter submits it. No dots or characters appear while typing because sudo—not Chimera—owns the password input. Chimera never reads, transmits, logs, persists, or includes the password in permission actions or tool results.

If validation succeeds, Chimera restores the TUI and executes the exact approved command through the normal captured executor. Failed authentication, Ctrl+C, a missing `sudo` executable, or terminal handoff failure restores the TUI and prevents command execution. When Chimera already runs as root, validation is already satisfied, but the sudo command still requires explicit approval. Running Chimera as root is strongly discouraged because every host command—not only sudo—would already be privileged.

This initial capability is intentionally limited to the foreground owner-local interactive TUI. Background sudo is rejected before launch. `chimera run`, `chimera serve`, attached/API/SSE/GUI clients, and headless subagents can approve a request but cannot safely provide owner-local authentication, so the command fails closed with guidance rather than reading from closed stdin. Configure non-interactive privilege outside Chimera or use the owner-local interactive TUI for those workflows.

Sudo timestamp caching remains controlled by the host's sudoers policy, but it never bypasses Chimera's per-command approval. Commands containing sudo credential invalidation (`-k`, `-K`, or their long forms) are hard-blocked because they can invalidate the authentication precondition before a later command segment runs.

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

`autoAllowThrough` accepts `none`, `safe`, `caution`, or `danger`; critical is never automatically allowed. `enabled: false` restores legacy host permission behavior only for non-sudo commands and prints a warning. Mandatory sudo approval, authentication, and credential-invalidation blocks remain active.

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
