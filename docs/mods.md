# Mods

A mod runs trusted code inside Chimera’s process. Mods receive their API through `register(on)`, not runtime package imports.

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

