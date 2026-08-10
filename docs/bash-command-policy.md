# Host bash command policy

Chimera analyzes every agent-issued **host** bash command before execution. Sandbox-target commands keep the existing sandbox policy.

The policy is an ordered pipeline:

1. `@aslamplr/pi-safe-shell@0.7.1` (MIT) classifies command risk as `safe`, `caution`, `danger`, or `critical`.
2. Chimera derives read, write, and delete effects for supported literal Bash commands and redirects.
3. Chimera checks those paths against the session's canonical read/write roots.

A command can run unattended only when its risk is within the configured threshold and every filesystem effect is understood and authorized. Dynamic expansion, unsupported executables, analyzer failures, unauthorized paths, and above-threshold risk require approval. Critical commands always require one-time approval.

```json
{
  "commandPolicy": {
    "hostBash": {
      "enabled": true,
      "autoAllowThrough": "caution"
    }
  }
}
```

`autoAllowThrough` accepts `none`, `safe`, `caution`, or `danger`; the default is `caution`. This threshold cannot bypass path, unresolved-effect, or analyzer-error findings. Existing remembered command allows also cannot bypass mandatory findings.

`enabled: false` explicitly restores legacy host permission behavior and prints a warning. An unavailable analyzer never disables policy automatically: interactive sessions prompt and headless sessions deny.

## Approval actions

For mandatory findings, the TUI offers:

- allow once;
- deny once;
- deny with feedback to the continuing agent run;
- allow once and add a proposed read/write directory to the current session, when one narrow grant can resolve all path findings.

Session directory grants are revalidated and persisted before the command is allowed. The TUI queues concurrent parent and subagent permission requests.

## Limits

Static analysis is approval policy, not process confinement. Runtime data, scripts, approved commands, background processes, symlink races, and downloaded programs can behave differently after analysis. Use Chimera's sandbox when filesystem or process isolation is required.

The initial analyzer build supports the Node platforms on which `web-tree-sitter` and the bundled Bash grammar WASM run. Analyzer initialization or packaging failures become visible approval errors rather than fail-open execution.
