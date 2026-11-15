# MCP recovery investigation (mve6pf9k)

## Result

Chimera cached a closed MCP client and its tool catalog until session disposal.
A later call reused that client and failed instead of reconnecting. This defect
is reproduced on main `0733a563dd7645599bf6e4f0e2d2e50fbf6a4691` and fixed in
`5b55494aa056ba070d434e5c35cbf4f141367808`.

**The original incident's first transport failure remains unproven.** A large
archived-task response is a plausible trigger, not an established historical
cause. The fix repairs a confirmed recovery defect without assuming a mod,
authorization, or token fault.

## History checked first

- Chimera main through PR #7 (`0733a563`), including the startup append,
  compaction, mod, idle-event and clean-stop changes. Open PR #6 concerns push
  approvals. None changes the MCP client's disconnect recovery.
- Legato main through PR #96 (`c4d31787`), including PR #93's native lifecycle
  and persistent SSE stream fixes. That report explicitly leaves a similar
  MCP-specific `request_access` failure unresolved.
- Chimera `99d44f9d3c4b75ab14132534fc0414c84402e5c5` and `0733a563` have identical
  MCP client code. Both contain the defect. This is not a duplicate of the
  recent native SSE recovery fix.

## Operational evidence and limits

The Reeve supplied content-free metadata from the incident on 15 November 2026.
No configuration, environment, token, raw conversation, or authenticated endpoint
was included in this report.

- Saved events contain 155 unique MCP calls and 19 generic failures. They need
  not represent every error displayed in the UI.
- First saved failure: `GET /api/tasks/archived`, **01:50:18.993–01:50:19.105 UTC**
  (112 ms). Concurrent task-search and UI-items reads succeeded.
- The next four MCP calls at 01:50:34.291 UTC failed in 1–20 ms. A later
  `instance_status` call failed in 1 ms. This is consistent with reuse of a
  disconnected client, not repeated 30-second call timeouts.
- Largest captured successful result: 30,890 bytes. This is a reserialized
  stored result, **not** a wire-frame measurement of the failed archived read.
- A narrowly filtered log extraction found no matching MCP diagnostics in the
  selected time window. Format/time-zone uncertainty limits this negative
  result. The old wrapper also discarded the underlying call exception.
- Reload at **02:56:19 UTC** restored tools. Native SSE EOF/refused-port messages
  at reload concern the old endpoint; they do not establish the initial cause.

Notifications travel over Legato-to-Chimera HTTP, independently of the stdio
`legato mcp serve` child. Mod state uses another `legato agent link chimera`
child. Continued notifications therefore do not establish MCP transport health.

Host source metadata identified Chimera `99d44f9` and Legato `741dfc19`; the
reported runtime versions were `dev`. Source HEAD is not proof of the running
artifact's SHA. No installed binary provenance or production deployment is
claimed.

## Isolated reproduction and fix

Actual SDK stdio fixtures reproduced both child exit and receive-buffer overflow.
The latter uses 1,000 synthetic archived-card-shaped rows, not the live board.
The SDK closes stdout transport when the 100,000-byte receive buffer overflows;
that happens before Chimera's parsed-result size check. On baseline, subsequent
small reads still failed with the generic connection/authorization message.

A separate fixture proved that unconsumed piped stderr could block replies.
That is another confirmed defect, not a claim about the incident's trigger.

The fix:

- Own initialization and discovery by a connection, with one shared connection
  and discovery operation for concurrent callers.
- Evict only the owning closed connection. Its old catalog cannot contaminate
  a replacement. A later, new call reconnects and rediscovers.
- Retire HTTP 404 sessions during calls or discovery, without replay. Keep the
  existing OAuth refresh/login behavior.
- Drain and discard stdio diagnostics. Return fixed, safe failure categories
  instead of raw errors, response content, URLs, or cancellation reasons.
- Close initializing children during session disposal and forbid reuse of a
  disposed manager.

**No failed tool call is automatically retried.** The remote operation can
already have completed. Errors direct the caller to check its result before
retrying a mutation. A timeout or cancellation alone does not discard an
otherwise healthy connection.

## Verification

All commands used an isolated home and removed inherited agent identity, mods,
configuration and credentials. Fixtures used local scripted models and loopback
HTTP servers. No running Legato instance was tested, restarted or reconfigured.

- Test-first exit/overflow and concurrent-reconnect regressions failed before
  their fixes. Stderr and HTTP-discovery fixtures also failed before their fixes.
- Final baseline recheck with only the production file restored from `0733a563`:
  four existing client tests passed, all eight new client cases failed.
  Both new built-agent cases also failed against the rebuilt baseline CLI.
  The fix was restored byte-for-byte and the CLI rebuilt afterwards.
- Full workspace build: passed.
- Root `tsc -p tsconfig.json --noEmit`: passed.
- Recursive workspace tests (`--workspace-concurrency=2`, `--testTimeout=20000`):
  **2,630 passed, 14 default-gated skips**, exit 0. CLI: 406 passed, 11 skips.
- Client plus built-agent recovery files: **14 cases passed in each of ten
  isolated repetitions**. Built `chimera run` executes the registered MCP tool,
  sees an ambiguous failure, and completes a new small read. The journal records
  the failed operation exactly once and one replacement child.
- Biome checks on all four changed source/test files and `git diff --check`:
  passed.
- Test audit: six new declarations (ten cases) kept; no redundant cases,
  test-only production exports, flags, or hooks added. The built-process cases
  protect registration/bundling separately from client transport behavior.

Reproduction entry points after building the workspace:

```sh
pnpm --filter @chimera/cli test test/mcp-client.test.ts test/mcp-recovery-process.test.ts
pnpm -r --workspace-concurrency=2 test --testTimeout=20000
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

## Deployment and exclusions

This change is Chimera-only. After review and merge, build/install a Chimera
artifact containing the fix. Existing Chimera processes keep their loaded code;
use the new artifact for new sessions or an explicitly operator-approved reload.
No Legato runtime patch is required for this fix. This investigation performed
no production reload, restart, credential/configuration change, or replay of an
incident mutation.

Configuration hot reload, adding new registered tools mid-session, and a valid
but empty catalog at startup remain outside this disconnect fix. The exact
historical stdout frame and child-exit cause remain unknown. Default-gated
Docker/tmux/other optional scenarios are not claimed as tested. Presentation-only
recovery-excerpt task `2ghzgdju` has no overlapping runtime edits.
