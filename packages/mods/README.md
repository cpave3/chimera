# Mod host

A folder contains `chimera-mod.json`, with required `name`, `version` and
`apiVersion: 1`. Optional `module` names an `.mjs` or `.mts` file relative to the
folder. Without `module`, the folder is a bundle-only mod; no default entry is
imported. Optional bundle fields are `mcpServers`, `skills`, `commands`, `agents`
and `modes` (the last four name directories).

`ModHost.create` loads `folders` (flag order), `envDirs` (a path list, defaulting
to `CHIMERA_MOD_DIRS`), then `userDirectory` (default `~/.chimera/mods`, alphabetical).
It never discovers repository-local mods. `disabled` applies only to user mods;
`noMods` skips all sources. The first name wins. `host.mods` records loaded,
disabled, duplicate, failed and unsupported-api statuses, manifests and hook names.
Failures skip only that mod, call `warn`, and produce one status message through
the application's `ui` callback. Registration has a five-second limit.

`.mts` requires Node 22.18+ (or Bun). Both runtimes enforce erasable TypeScript:
top-level `import type` rather than inline type imports, real extensions in
relative imports, no enums, constructor parameter properties, runtime namespaces,
decorators, tsconfig path aliases or TypeScript under `node_modules`. Local
imports are checked recursively before registration.

A mod exports `register(on)` and registers hooks as `on(name, async ($, event, next) => ...)`.
The application supplies session actions through `sessionContext(sessionId)` as a full
context (`session`, `prompt`, `message`, `turn`); the host owns utility APIs.
`serverUrl()` supplies the full process-level server URL, including its secret.
An event without `sessionId` gets utilities and server context without looking up
a session. `endSession(id)` invalidates captured calls for that session.

Hooks use the spec names (`tool.call`, `turn.complete`, `permission.request`,
etc.); unknown names fail registration. Observers run serially per session and
middleware runs first-loaded outermost. The hook budget is ten seconds of own
time, excluding `next()` and utility calls, including waits on child output and
exit. A timed-out observer is skipped; a timed-out interceptor passes downstream.
Dispatch has a sixty-second mod limit. Already-started terminal work is not run
twice or cancelled by a mod timeout.

`$.process.spawn({argv, env?, cwd?})` returns a synchronous handle with `write(text)`,
`close()`, `kill(signal?)`, `output` (an async iterable of `{stream, text}`), and
`exitPromise` (`{code, signal}`). Children inherit Chimera's environment and run outside
the command sandbox. After the application's end-hook window, `host.shutdown()` sends
SIGTERM and, after two seconds, SIGKILL to children still running.

`$.store.get(key)`, `set(key, value)` and `delete(key)` persist JSON per mod under
`~/.chimera/mod-data/<name>/`. `$.store.directory` is a writable folder. **Sandboxed
commands can read mod-data: do not put secrets there.**

Other utilities: `$.env.get(name)` / `set(name, value)`, `$.clock.now()` / `sleep(ms)`,
`$.http.fetch(input, init?)` (30-second limit), and
`$.ui.log(text, {to: 'debug' | 'status' | 'scrollback'})`. The application routes UI
output; mods do not write raw output over the terminal UI.

Build before tests (`pnpm --filter @chimera/mods build`).
`CHIMERA_TEST_MOD_BINARY=1 pnpm --filter @chimera/mods test` also compiles a small
host harness with Bun and loads `.mjs` and `.mts` from disk. This checks the host's
compiled import path, not the application's CLI/release integration.
