#!/usr/bin/env node
// React picks its development or production build from NODE_ENV when it is
// first loaded, so NODE_ENV must be set before anything imports react or ink.
// Static imports would run before this body; the CLI therefore loads through
// a dynamic import, kept out of this bundle by the tsup config. NODE_ENV is
// removed again afterwards so the bash tool and hooks do not inherit it
// (NODE_ENV=production makes npm and pnpm skip devDependencies).
const presetNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = presetNodeEnv ?? 'production';
void import('./index.js').then(({ runCli }) => {
  if (presetNodeEnv === undefined) delete process.env.NODE_ENV;
  process.title = 'chimera';
  return runCli();
});
