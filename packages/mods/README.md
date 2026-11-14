# Mod host

A mod exports `register(on)` and registers hooks as `on(name, async ($, event, next) => ...)`.
The application supplies session actions through `sessionContext(sessionId)` as a full
context (`session`, `prompt`, `message`, `turn`); the host owns utility APIs.

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
