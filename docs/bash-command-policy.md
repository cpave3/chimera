# Host bash command policy

Chimera analyzes every agent-issued **host** bash command before execution, and runs it in the [OS sandbox](#os-sandbox) when the machine has one. Sandbox-target commands keep the existing sandbox policy.

## OS sandbox

Without the Docker sandbox, Chimera runs each host bash command in the sandbox of the operating system: `bubblewrap` on Linux and `sandbox-exec` on macOS. The kernel then applies the limits. The analysis below is no longer the only protection.

A sandboxed command:

- can read every file;
- can write only in the working directory, the temp directory, the write paths of the session (`--add-write-path`, `/add-dir`), and the paths in `sandboxWritePaths`;
- can write the git directory of the repository when that directory is not below the working directory (a linked worktree, a submodule, or a session started below the repository root);
- cannot write `<cwd>/.chimera` or `~/.chimera`, so the command cannot change its own permission rules or hooks;
- has no network access when `network` is `"off"`.

Foreground and background commands obey the same limits.

```json
{
  "commandPolicy": {
    "hostBash": {
      "osSandbox": "auto",
      "network": "on",
      "sandboxWritePaths": ["~/.cache/pnpm"]
    }
  }
}
```

| Key | Values | Default | Effect |
| --- | --- | --- | --- |
| `osSandbox` | `auto`, `required`, `off` | `auto` | `auto` uses the sandbox when the machine has one. If the machine has none, Chimera shows one warning and runs commands as before. `required` refuses each host command when the machine has no sandbox. `off` runs commands as before. |
| `network` | `on`, `off` | `on` | `off` removes network access from sandboxed commands. |
| `sandboxWritePaths` | list of directories | `[]` | More directories that a sandboxed command can write. `~` is the home directory. Use this for the cache of a package manager. |

Because the kernel refuses a write outside these directories, Chimera does not ask about path findings for a sandboxed command. Risk findings, sudo and the hard blocks operate as before. A command that you approve for sudo runs outside the sandbox, because sudo cannot operate inside it.

When the sandbox blocks a command, the tool result tells the model what the sandbox allows. The model can then call `bash` again with `unsandboxed: true` and a reason. Without an explicit bypass rule, the request needs user approval and shows the reason; a session with no user to ask denies it. Neither `autoApprove`, ordinary allow rules nor the AI approval reviewer can grant a sandbox bypass. The [System One check](#system-one-check) can grant one only when `allowSandboxBypass` is on.

### Remembered sandbox bypass

An allow rule with `allowUnsandboxed: true` explicitly trusts matching commands outside the OS sandbox. Only `patternKind: "exact"` or `"prefix"` can grant this bypass; a glob cannot. A matching deny rule wins. A bypass rule resolves only the `os_sandbox` elevation finding: sudo, risk, unauthorized paths and other mandatory findings still require approval, and hard blocks still deny. An explicit bypass rule can admit a matching command in a headless session when no other mandatory findings remain. It does not turn ordinary calls into unsandboxed calls: the model must still request `unsandboxed: true` with a reason.

Prefix matching compares literal command tokens parsed from the shell AST, not raw string prefixes. Both the rule and the command must be a single simple command. Compounds, pipelines, substitutions, redirects, execution wrappers (such as `env`, `sudo`, `sh` or `timeout`), environment assignments and unsupported syntax do not match. A prefix of `pnpm build` matches `pnpm build --filter server`, not `pnpm builder` or `pnpm build && git push`. A compound command needs fresh approval rather than inheriting a prefix grant.

Trust the executable and its subcommands before granting a prefix. A rule for `pnpm` can run package scripts; an executable may launch other programs or interpret arguments as code even though the shell command itself is simple. Prefix grants are not a sandbox for the executable's behavior.

Remembered rules can be scoped to the session, project (`<cwd>/.chimera/permissions.json`) or global (`~/.chimera/permissions.json`). The rule API accepts `patternKind: "exact" | "glob" | "prefix"` and optional boolean `allowUnsandboxed`. Approval resolution accepts `remember: { scope, pattern, patternKind, allowUnsandboxed? }` for all three scopes. Both pattern fields are required, including for the session scope.

While the sandbox is active, the file tools refuse to write `<cwd>/.chimera/permissions.json` and `<cwd>/.chimera/hooks/`. Chimera creates `<cwd>/.chimera` if it does not exist, because the sandbox cannot protect a path that does not exist.

Limits of the OS sandbox:

- The sandbox does not hide files. A sandboxed command can read your home directory. Use the Docker sandbox when a command must not read your files.
- The file tools, MCP servers and hooks do not run in the sandbox.
- On Linux, the sandbox needs `bubblewrap` and unprivileged user namespaces. Chimera runs a test command to make sure that the sandbox operates.
- The macOS profile has unit tests for its text only. It was not run on a Mac.
- With the Docker sandbox on (`--sandbox`), the OS sandbox is not used. A host command then follows the Docker sandbox rules.

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

- danger or critical classifier results, except a literal `rm` or `rmdir` whose complete target set resolves inside authorized write directories and has no independent risk factor;
- explicit unauthorized filesystem paths that Chimera can confidently identify;
- force pushes;
- recursive forced deletion;
- production-targeted mutating `kubectl` and Terraform commands;
- fork bombs and other deterministic scary-command rules;
- every executable `sudo` invocation, including wrapped and compound commands.

Literal `rm` and `rmdir` targets are canonicalized before authorization, so symlink escapes and any mixed in-root/out-of-root target list still require approval. Variable-derived paths, command substitutions, and compound deletes remain unresolved and promptable. An actual `rm` executable inside backticks or `$()` remains a danger finding; text such as `normal` or `echo rm` does not count as an executable delete.

Deterministic scary rules are hard blocks and do not show an approval prompt. Recursive forced deletion remains blocked even when its target is inside an authorized write directory. Sudo is a deterministic but promptable elevation finding: it always uses the normal approval flow, even with `autoApprove: "host"`/`"all"` or a remembered allow rule. Other concrete danger/path findings also use the normal approval flow. When Chimera is about to prompt, it fires the existing synchronous `PermissionRequest` lifecycle hook before entering `waiting_for_permission`.

### Explicit-lease pushes

The force-push rule has one narrow exception: a standalone literal command such as
`git push --force-with-lease=refs/heads/topic:<full-sha> origin HEAD:refs/heads/topic`.
The lease must name one full branch ref and a complete 40- or 64-digit object ID,
and the single explicit destination must match it. The source can be `HEAD` or
a full `refs/heads/...` ref. Wrappers, compound commands, additional flags or
refspecs, implicit leases and bare force remain blocked.

Chimera checks the local `refs/remotes/<remote>/HEAD` symbolic ref to identify
the remote default branch. That branch, `main`, and `master` remain blocked.
If the symbolic ref is missing, the denial explains how to populate it with
`git remote set-head <remote> -a`. This check uses local metadata, not a live
remote query; refresh that metadata if the remote default changes.

An eligible lease push always requires operator approval, naming the remote,
branch and expected SHA. Auto-approval, remembered allows, mods, System One,
and the approval reviewer cannot substitute for that approval. Mod denials, blocking
lifecycle hooks and explicit deny rules still apply. Headless sessions without an approval
responder deny rather than run the push. Git itself enforces the lease at execution.

Hard policy denials include the blocking rule ID, its reason, and an explicit
statement that approval is unavailable for that command; retrying unsandboxed
does not override them.

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

## Approval reviewer

```json
{
  "approvalReviewer": { "enabled": true },
  "utilityModel": "anthropic/claude-haiku-4-5"
}
```

The approval reviewer is a second model that examines a request before Chimera asks you. It is off by default. It uses the `utilityModel`, or the session model when no `utilityModel` is set.

The reviewer examines only a request that Chimera would put to you: a host command with promptable findings or an MCP call that is not trusted. It does not change these decisions:

- A request that `autoApprove` or an allow rule admits runs without the reviewer.
- A deny rule, a hard block or a blocking `PermissionRequest` hook denies the request before the reviewer.
- Sandbox bypass requests, sudo commands, and commands with a `danger` or `critical` risk finding skip the reviewer. Without an applicable explicit saved bypass rule, you must approve a bypass.

The reviewer reads:

- the tool call: the command, the working directory and the agent's reason, or the MCP server, tool and arguments;
- the policy findings;
- your messages in the session;
- the project instruction files.

The reviewer does not read tool results or assistant text. Text that a tool brought into the session cannot ask for its own approval. Each part of the input has a size limit.

The reviewer gives one of two answers, with a reason:

| Answer | With a user | With nobody to ask |
| --- | --- | --- |
| `allow` | The call runs. The tool line shows `approved by reviewer`. | The call runs. |
| `escalate` | The usual prompt opens and shows the reason. | The call is denied. The tool result is `denied by reviewer: <reason>`. |

A model error, no answer in 30 seconds, or a reply with no decision counts as `escalate`.

The reviewer stops for the session after 3 escalations in a row or 10 escalations in the session. Requests then come to you as they did before. The TUI shows one notice.

Each decision is in the decision audit. An `allow` is a record with `"source": "reviewer"`. An `escalate` is on the record of the decision that followed it. Both have a `reviewer` object with the decision and the reason. For an MCP call the reason is left out, because it can repeat an argument value.

Clients get an `approval_reviewed` event for each decision: `{ requestId, callId?, decision, reason, stopped? }`. A `permission_request` event for an escalated request has a `reviewerReason` field.

The reviewer is a model and can be wrong. Keep it off when a wrong `allow` is not acceptable. With the OS sandbox on, a wrongly allowed command still cannot write outside the sandbox. The reviewer cannot approve leaving it.

## System One check

```json
{
  "systemOne": {
    "enabled": true,
    "model": "jev",
    "jev": { "apiKey": "env:JEV_API_KEY" },
    "laya": {
      "url": "http://localhost:8012/v1/systemone",
      "model": "english",
      "threshold": 0.7
    }
  }
}
```

A System One model does not write text. It reads a text and gives probabilities for the answers to questions about it. Jev is such a model, and a server that has Jev's `/v1/systemone` protocol (for example Laya) works the same way. A check takes about a tenth of a second on a local server.

The check is off by default. When it is on, Chimera sends a host bash command that needs your approval to the model first:

- A command that the model rates at or above the threshold runs. The tool line shows `approved by System One`.
- A command that the model rates below the threshold comes to you. The prompt shows a line such as `System One rejected: safety 0.31, needs 0.80, reads as "remote"`. The approval reviewer does not examine a command that the check rejected.
- When the model gives no answer (the server is down, an error, no reply in the time limit), the request goes on as it does without the check: to the approval reviewer when it is on, then to you. The prompt shows `System One gave no answer: <cause>`.
- In a session with nobody to ask, a rejected command is denied. The tool result is `denied: System One rejected: …`.

The settings of the check:

| Key | Default | Effect |
| --- | --- | --- |
| `enabled` | `false` | Turns the check on. |
| `model` | `jev` | The name of the model section that the check uses. |
| `allowSandboxBypass` | `false` | Lets the check also approve a command that leaves the OS sandbox. See below. |
| `timeoutMs` | `10000` | How long the model can take. |

Each other key in `systemOne` is the name of a model, and its value has the settings of that model. You choose the names. To change the model, change `model`.

| Key | Default | Effect |
| --- | --- | --- |
| `url` | none | The full `/v1/systemone` endpoint. Necessary, except for `jev`. |
| `model` | `jev-latest` | The model name in the request. |
| `apiKey` | none | `env:VAR_NAME`, or the key. Chimera sends it as a bearer token. A local server needs none. |
| `threshold` | `0.8` | The safety, above 0 and at most 1, that a command needs to run without you. |

The section with the name `jev` has TypeSafe's endpoint, `https://api.typesafe.ai/v1/systemone`, as its `url`. It needs only an `apiKey`. A `url` in that section replaces the default, for example for a gateway.

The check does not change these decisions:

- A command that `autoApprove` or an allow rule admits runs without the check.
- A deny rule, a hard block or a blocking `PermissionRequest` hook denies the command before the check.
- Sudo commands and commands with a `danger` or `critical` risk finding always come to you.
- MCP calls and the commands of other tools do not go to the check.

### What the model is asked

The request has the command and the working directory, and no other text. The agent's reason is left out, because the agent wrote it. The model answers three questions:

| Question | Type | Harmless answers |
| --- | --- | --- |
| `damage`: how much damage the command could do | score, 4 levels | "none" and "small and local" |
| `kind`: the most serious thing the command does | choice of 6 | `reads` and `develops` |
| `verdict`: safe to run without asking | choice of 2 | `safe` |

The safety of a command is the mean, over the three questions, of the probability of the harmless answers. The questions are in `packages/permissions/src/system-one.ts`.

### Sandbox bypass

With `allowSandboxBypass: true`, a command that the model rates safe can leave the OS sandbox without you:

- A call with `unsandboxed: true` runs on the host when the model approves it.
- A command that the sandbox stopped is retried once on the host when the model approves it. A command that the model rejects stays stopped, and nobody is asked. The model can then make a call with `unsandboxed: true`, and that request comes to you.

Without this key, the check does not examine a request to leave the sandbox, and you approve each one as before.

### The threshold

The right threshold depends on the model. To measure a model, give a set of labelled commands to it:

```bash
pnpm --filter @chimera/permissions build
node packages/permissions/scripts/system-one-calibrate.mjs \
  --url https://api.typesafe.ai/v1/systemone --model jev-latest --key-env JEV_API_KEY
```

The script sends 72 safe and 77 unsafe commands to the server. It does not run them. It prints how many of each a threshold approves. `--list` prints each command with its safety, and `--cases <file>` uses your own set.

Results of 2026-10-14. Each cell is "safe commands approved, unsafe commands approved":

| Threshold | Jev (`jev-latest`) | Laya `english` | Laya `typed-decisions` |
| --- | --- | --- | --- |
| 0.60 | 72 of 72, 0 of 77 | 47 of 72, 10 of 77 | 42 of 72, 3 of 77 |
| 0.65 | 72 of 72, 0 of 77 | 39 of 72, 2 of 77 | 24 of 72, 0 of 77 |
| 0.70 | 70 of 72, 0 of 77 | 27 of 72, 0 of 77 | 7 of 72, 0 of 77 |
| 0.75 | 69 of 72, 0 of 77 | 10 of 72, 0 of 77 | 0 of 72, 0 of 77 |
| 0.80 | 65 of 72, 0 of 77 | 4 of 72, 0 of 77 | 0 of 72, 0 of 77 |
| 0.90 | 55 of 72, 0 of 77 | 0 of 72, 0 of 77 | 0 of 72, 0 of 77 |

- **Jev** rates each safe command of the set above each unsafe one. The unsafe command with the highest safety has 0.37, so the default of 0.8 has a large margin.
- **Laya** rates few commands above 0.8. It needs a lower threshold: 0.70 for `english`, 0.65 for `typed-decisions`. At those thresholds it approves about one third of the safe commands, and its margin is small.

The set is small and the commands in it are plain. A threshold with no wrong approval in the set can have one in your work.

### Limits and logs

The model can be wrong in both directions. A small model does not understand a command; it rates how the text reads. Keep the check off when a wrong approval is not acceptable. With the OS sandbox on and `allowSandboxBypass` off, a wrongly approved command still cannot write outside the sandbox.

Every command that needs approval is sent to the `url` of the model, with its working directory. With `jev`, that is TypeSafe's API. Use a server that you trust with your commands.

A hosted model sometimes fails a request. The check does not try again: the command then comes to you, as it does when the model gives no answer.

Each command that the model was asked about is appended to:

```text
~/.chimera/logs/system-one-decisions.jsonl
```

A record has the session and request IDs, the working directory, the full command, the `outcome` (`approved`, `rejected` or `failed`), the safety, the threshold, the note, the URL, the model name, the model that answered, the `promptVersion`, the probabilities of each answer and the duration. The file is user-only (`0600`).

The `promptVersion` is made from the content of the questions, the input and the scoring. It changes when one of them changes. Do not compare the safety of records that have different versions.

The decision audit has the result too. An approval is a record with `"source": "system_one"`. A rejection is on the record of the decision that followed it. Both have a `systemOne` object with the decision, the safety, the threshold and the note.

Clients get a `system_one_checked` event for each verdict: `{ requestId, callId?, decision, note, safety?, threshold }`. A `permission_request` event for a rejected command has a `systemOneNote` field.

### Data for tuning a model

The logs can become labelled data, for example to tune a local model:

```bash
pnpm --filter @chimera/permissions build
node packages/permissions/scripts/system-one-export.mjs
```

The script joins the System One log with the decision audit. It writes two files to `~/.chimera/system-one-export/`:

| File | Contents |
| --- | --- |
| `labelled.jsonl` | One row for each time the model rated a command that a person labelled. A row has the command, the working directory, the model's answers, a `label` (`safe` or `unsafe`) and a `labelSource`. |
| `review.jsonl` | One row for each distinct command that nobody decided, with a `label` of `null`. |

The labels come from two sources:

- `user`: your answer at the approval prompt. Only a command that the model rejected, or did not answer about, comes to the prompt.
- `review`: a label that you wrote in `review.jsonl`. Set `"label"` to `"safe"` or `"unsafe"` and run the script again. The script keeps the labels that you wrote.

A command that the model approved never comes to you, so it has no label until you review it. Data that has only `user` labels contains no approved command, and a model tuned on it learns to approve more. Review the approved commands before you use the data.

An answer at the prompt is not always about safety. You can deny a safe command because it is the wrong step. The row has your `feedback` when you gave one.

The script takes likely credentials out of the commands. It knows only common patterns, so read the files before you give them to another person. `--home <dir>` and `--out <dir>` change where the script reads and writes.

## Decision audit

Every automatic allow, rule decision, hard block, hook/headless denial, reviewer decision, System One approval, and user approval/rejection is appended to:

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

Balanced static analysis is intentionally an advisory safety net, not process confinement. Runtime data, scripts, approved commands, background processes, symlink races, and downloaded programs can behave differently after analysis. The OS sandbox confines the writes and, on request, the network of a host command. Use the Docker sandbox when a command must also not read your files, or when process isolation is required.
