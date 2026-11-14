# Isolated integration tests

Run package tests with `pnpm --filter @chimera/<package> test`, or all packages
with `pnpm -r test`. Build workspace dependencies first: tests import their
`dist/` entry points, not their sources.

Every Vitest configuration loads `vitest.isolation.ts` before test modules.
It gives each fixture file a temporary HOME, XDG folders and tmux socket folder,
and removes inherited agent identity, broker settings, extension paths, provider
credentials and shell startup hooks. Fixture children inherit that environment.
This changes **test processes only**, not production mod discovery or the
launching agent's environment. Tests of discovery or environment configuration
set their own synthetic values after setup; discovery is not disabled.

A runner launched inside Legato must not load the launching agent's
`CHIMERA_MOD_DIRS`: an environment-discovered mod can start its real link helper
when a fixture session starts, even if that session has an explicit scratch home.
The portable canary probe exercises actual fixture sessions with a synthetic
inherited mod and dummy helper, and asserts that no helper was invoked:

```sh
node scripts/check-test-isolation.mjs
# {"fixtureTestExit":0,"syntheticHelperCalls":0}
```

The probe uses no real mod, broker or provider. The fixture tests also assert
that deliberately loaded local mods still receive lifecycle events, and that
child processes have no inherited launching identity.

On a shared worker, acquire its shared heavy-build lock before a test runner
changes HOME. For the integration worker:

```sh
flock "$HOME/.nuget/packages/.legato-heavy.lock" pnpm -r test
```

Do not replace the shared lock with a path under a fixture's private HOME or
`/tmp`: that would no longer serialize with other workers.
