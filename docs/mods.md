# Mods

Load an external folder with `--mod-dir <directory>` (repeatable), or include it in
`CHIMERA_MOD_DIRS`, separated by the platform path delimiter. `--no-mods` disables
mods. Mods run inside Chimera's process and are not sandboxed.

A folder contains `chimera-mod.json` with `name`, `version`, `apiVersion: 1` and
`module: "index.mjs"`. The module exports `register(on)` before sessions begin.

```js
export function register(on) {
  on('turn.complete', async ($, event) => {
    $.ui.log(`Turn ended: ${event.reason}`, {to: 'debug'});
  });
  on('tool.call', async ($, event, next) => {
    if (event.toolName === 'bash') return {decision: 'block', reason: 'No shell'};
    return next();
  });
}
```
