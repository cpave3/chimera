# Mods

A mod runs trusted code inside Chimera's process. It can observe sessions, intercept
agent actions and call the API handed to its hooks. Mods and their subprocesses
run **outside** Chimera's bash/Docker sandbox. Do not load untrusted mods.

## Create and load a mod

A folder needs `chimera-mod.json`:

```json
{
  "name": "example",
  "version": "1.0.0",
  "apiVersion": 1,
  "module": "index.mjs"
}
```

`index.mjs` exports `register(on)`. There is no runtime import from Chimera:

```js
export function register(on) {
  on('session.start', async ($, event) => {
    await $.ui.log(`Started ${event.name} (${event.reason})`, { to: 'debug' });
  });
  on('tool.call', async ($, event, next) => {
    if (event.toolName === 'bash' && event.args.command === 'forbidden') {
      return { decision: 'block', reason: 'Blocked by example policy' };
    }
    return next();
  });
}
```

Load with repeatable `--mod-dir <folder>` flags, a platform path-list in
`CHIMERA_MOD_DIRS`, or a folder/symlink in `~/.chimera/mods/`. Load order is flags,
environment, then installed folders alphabetically. First mod of a name wins.
Repository `.chimera/` directories never load mods.

`mods.disabled` in config disables named installed mods, not flag/environment
folders. `--no-mods` disables all mods. Child agents load mods too. Mods are not
hot-reloaded. Restart Chimera after changing one.

The module is optional: a manifest may contain only bundles. Optional fields are
`description`, `mcpServers`, `skills`, `commands`, `agents` and `modes`. Asset fields
are directory paths relative to the mod folder:

```json
{
  "name": "example-bundle",
  "version": "1.0.0",
  "apiVersion": 1,
  "commands": "commands",
  "skills": "skills",
  "agents": "agents",
  "modes": "modes",
  "mcpServers": {
    "helper": {
      "transport": "stdio",
      "command": "node",
      "args": ["${MOD_DIR}/helper.mjs"],
      "subagents": false
    }
  }
}
```

Bundled assets use the normal formats (`SKILL.md` in each skill directory;
Markdown command, agent and mode files). Project/user assets win name clashes;
bundled assets precede compatibility tiers. Their source is `mod:<name>`.
Configured MCP servers win over bundled ones; first loaded mod wins between
bundles. MCP servers start in subagents unless `subagents: false`. `${MOD_DIR}`
expands in commands and paths, and the mod folder is the server's working directory.
Without an explicit `env` map, only `HOME LOGNAME PATH SHELL TERM USER` are passed.
An explicit map inherits Chimera's secret-scrubbed environment and overlays its
entries. Values can refer to `env:NAME` or `${NAME}`; missing variables are errors.

## JavaScript and strict TypeScript

Prefer `.mjs`. `.mts` works on Node **22.18 or newer** and the release binary,
using Node's erasable TypeScript subset:

- Use top-level `import type` / `export type`, not inline type specifiers.
- Relative imports need real file extensions, including `.mts` when appropriate.
- No enums, runtime namespaces, constructor parameter properties, import aliases,
  export assignments or decorators.
- No tsconfig path aliases or TypeScript files under `node_modules`.
- Imported `.js` files obey their nearest `package.json` `type`. ESM syntax in
  a package explicitly marked `commonjs` is invalid even if Bun accepts it.

`register` is awaited for up to five seconds. An invalid manifest, unsupported API,
failed import or bad registration skips that mod rather than preventing startup.
Load errors go to the debug log, with a short TUI status message.

## Hooks and interception

Every handler receives `($, event, next)`. Within a session, observers run in event
order. Observers may call or ignore `next()`. Interceptors mutate the event before
`await next()`, and may inspect or replace the returned result afterward. Call
`next()` at most once. With multiple mods, first loaded is outermost.

Observer hooks:

| Hook | Important fields |
| --- | --- |
| `session.start` | `reason`: new/resume/fork/switch, `sessionId`, `name`, `parentSessionId?` |
| `session.end` | `reason`: exit/signal/delete/switch |
| `turn.start` | `turnId`, `source`: user/continuation/background/stop_retry/goal |
| `turn.complete` | `reason`, `error?`, `model`, `usage`, `contextFill` |
| `permission.resolved` | `requestId`, `decision`, `remembered` |
| `question.request`, `question.resolved` | `requestId`, questions or resolution status |
| `agent.spawn`, `agent.finish` | `agentId`, `description`, `background` |
| `background.start`, `background.exit` | `jobId`, `command`, exit information |
| `compaction.start`, `compaction.end` | reason, success/summary or error |
| `message.append` | text added without starting a turn |

Run-end reasons are `stop`, `max_steps`, `error`, `interrupted`, `timeout`,
`waiting_for_input` and `output_limit`.

Interceptors:

- `tool.call`: `toolName`, mutable `args`, optional `additionalContext`. Return
  `{decision: 'block', reason}` to block, or call `next()` to execute. Rewritten
  arguments are validated against the tool schema and passed to permissions.
  Return a replacement tool result after `next()` to change what the model sees.
- `permission.request`: after policy rules and auto-approval, before reviewer and
  operator. Return `'allow'`, `'deny'`, `'pass'`, or `{decision, message?}`. A mod
  cannot override a policy deny.
- `turn.step`: mutable `model` (`provider/model`), `effort`, `providerOptions` and
  `systemPrompt`. `event.usage` becomes available after `await next()`; the
  session's configured model is not changed.
- `prompt.submit`: mutate `event.text` then call `next()`, or return
  `{decision: 'drop', reason}`. Dropping starts no run.
- `turn.stop`: return `{decision: 'block', reason: 'Continue with this instruction'}`
  to continue rather than end, or call `next()` to pass.

Hooks have ten seconds of their own time; time awaiting `next()` and asynchronous
`$` calls does not count. One dispatch is bounded at sixty seconds. Timed-out
observers are skipped; timed-out interceptors pass. At exit, end hooks share a
two-second window. SIGKILL cannot deliver an end event.

## The `$` API

`$` addresses the event's session. Process-level contexts do not have session
fields/actions. Values come from the running process, not a binary on disk.

| API | Result / behavior |
| --- | --- |
| `$.chimera.version`, `$.api.version` | Running Chimera version and API integer (`1`) |
| `$.session` | Read-only id, name, cwd, status, parentId, isSubagent, model, usage |
| `$.session.messages()` | Read-only conversation snapshot |
| `$.server.url()` | Full server URL, including its secret if configured; keep it private |
| `$.prompt.submit({text})` | `{accepted: true}`, `{queued: true}`, or `{dropped: true, reason}`; busy submissions queue and resolve when their run starts |
| `$.message.append(text)` | Add context without starting a turn |
| `$.turn.abort()` | Interrupt the current turn |
| `$.process.spawn({argv, env?, cwd?})` | Synchronous process handle (below); never a sandboxed bash command |
| `$.http.fetch(input, init?)` | Fetch API, with a thirty-second limit |
| `$.env.get(name)`, `$.env.set(name, value)` | Read/write process environment; `undefined` deletes |
| `$.clock.now()`, `$.clock.sleep(ms)` | Epoch milliseconds and async sleep |
| `$.ui.log(text, {to})` | `debug`, `status` or `scrollback`; do not write raw terminal output |
| `$.store.directory` | Writable `~/.chimera/mod-data/<mod-name>/` |
| `$.store.get(key)`, `.set(key, json)`, `.delete(key)` | Async per-mod JSON persistence |

Process handles expose `write(text)`, `close()` (stdin), `kill(signal?)`,
`output` (async iterable of `{stream: 'stdout'|'stderr', text}`), and `exitPromise`
(resolves `{code, signal}`). Children inherit Chimera's environment, with the
server secret already removed. At shutdown Chimera terminates mod children, then
kills survivors after two seconds. Store files are readable from sandboxed bash:
do not persist secrets there. Calls on an ended session fail with `SessionEnded`.
Already-created process handles survive session switches and stay usable until
process shutdown. Refresh your saved `$` on each session event for subsequent
session-bound calls, including logging; an old `$` cannot spawn another helper.

## Versions and declarations

`apiVersion` changes for a removal or a change of meaning, not for additions.
`chimera version --json` and `GET /v1/instance` report supported versions in
`modApi`. Check this before relying on the API.

Generate declarations matching the running Chimera:

```sh
chimera mod types > chimera-mod.d.ts
```

```ts
import type { On } from './chimera-mod.js';
export function register(on: On) {
  on('session.start', async ($, event) => {
    await $.ui.log(`${$.chimera.version}: ${event.reason}`, { to: 'debug' });
  });
}
```

The repository package `@chimera/mod-api` contains types only, including
`ModTestHarness`; it has no runtime entry point and is not published to npm.
Use `import type`, never a runtime Chimera import.

## Author commands

```sh
chimera mod list --json
chimera mod validate ./my-mod --json
chimera mod test ./my-mod
```

List reports name, version, folder, source, hooks, bundled item names, error and
status: `loaded`, `disabled`, `failed`, `duplicate`, `unsupported-api`. It succeeds
even when individual mods failed, so their diagnostics can be inspected.

Validate checks the manifest/API, strict Node module rules, imports, `register`
(including unknown hook names), and parses bundles with the normal asset loaders.
It executes module initialization/registration: validation is not a sandbox.
JSON output includes `valid` and `error`; exit code is zero only for a valid mod.

## Test a mod without a model

Put `.test.mjs` files directly in `tests/`. Each exports `test(harness)` and may
use Node's assertion library. Chimera passes the harness in; no runtime Chimera
import is needed. For the example mod above:

```js
// tests/hooks.test.mjs
import assert from 'node:assert/strict';

export async function test(harness) {
  await harness.emit({
    type: 'session.start', sessionId: 'test', name: 'demo', reason: 'new',
  });
  assert.deepEqual(harness.calls.find(call => call.path === 'ui.log').args,
    ['Started demo (new)', { to: 'debug' }]);

  const result = await harness.emit({
    type: 'tool.call', sessionId: 'test', toolName: 'bash',
    args: { command: 'forbidden' },
  });
  assert.equal(result.decision, 'block');
  assert.equal(harness.results.at(-1).result.reason, 'Blocked by example policy');
}
```

Harness API:

- `$`: fake session/API. Calls are recorded, not sent to a real agent.
- `setResult('http.fetch', new Response('fixture'))`, or another dotted `$` method
  path: supply that method's return value for subsequent calls. Promises work too.
  Value fields can also be configured, e.g. `setResult('session.isSubagent', true)`.
- `emit(event, terminalResult?)`: dispatch to the mod's handlers, returning the
  interception result. `next()` reaches `terminalResult` unless another handler
  intercepts it. Observer handlers run even if earlier observers ignore `next()`.
- `calls`: ordered `{path, args}` records for `$` methods.
- `results`: `{event, result}` records for completed emissions.
- `processes`: recorded spawn options; no processes are actually started. Fake
  handles record operations as `process[0].write`, `.close`, `.kill`, etc.
  Configure `setResult('process[0].write', promise)` to stall or reject writes,
  or `setResult('process.spawn', customHandle)` to supply a complete fake handle.

Fake fetch returns an empty response unless configured; environment/store are
in-memory; the clock starts at zero and sleep resolves immediately. Each test file
gets a fresh harness and registration. Files run alphabetically; assertions/import
errors print `FAIL <file>: <message>` and make the command exit nonzero. Other files
still run. Empty test suites and missing `test(harness)` exports fail clearly.
