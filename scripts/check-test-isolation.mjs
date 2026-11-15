#!/usr/bin/env node
// Run real fixture sessions with a synthetic inherited mod and dummy helper.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'chimera-isolation-probe-'));
try {
  const home = join(root, 'home');
  const mod = join(root, 'canary');
  mkdirSync(home);
  mkdirSync(mod);
  const records = join(root, 'helper-records');
  const helper = join(root, 'helper.cjs');
  writeFileSync(
    helper,
    `const {appendFileSync} = require('node:fs');\nprocess.stdin.on('data', data => appendFileSync(${JSON.stringify(records)}, data));\n`,
  );
  writeFileSync(
    join(mod, 'chimera-mod.json'),
    JSON.stringify({ name: 'synthetic-canary', version: '1', apiVersion: 1, module: 'index.mjs' }),
  );
  writeFileSync(
    join(mod, 'index.mjs'),
    `export function register(on) {
    on('session.start', async ($, event, next) => {
      const helper = $.process.spawn({argv: [$.env.get('LEGATO_BIN'), $.env.get('CANARY_HELPER')]});
      await helper.write(JSON.stringify({type: 'fixture-start', identity: $.env.get('LEGATO_TASK_ID')}) + '\\n');
      helper.close(); await helper.exitPromise;
      return next();
    });
  }`,
  );
  const result = spawnSync(
    process.execPath,
    [
      join(repository, 'node_modules/vitest/vitest.mjs'),
      'run',
      'test/mod-runtime.test.ts',
      'test/environment-isolation.test.ts',
    ],
    {
      cwd: join(repository, 'packages/cli'),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH:
          dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + '/usr/bin:/bin',
        HOME: home,
        USERPROFILE: home,
        XDG_RUNTIME_DIR: join(root, 'run'),
        TMUX_TMPDIR: join(root, 'tmux'),
        CHIMERA_MOD_DIRS: mod,
        LEGATO_TASK_ID: 'dummy-identity',
        LEGATO_EXECUTION_ID: 'dummy-execution',
        LEGATO_BIN: process.execPath,
        CANARY_HELPER: helper,
        LEGATO_BROKER_SOCKET: join(root, 'nonexistent-broker'),
        LEGATO_BROKER_TOKEN: 'nonsecret-canary',
        LEGATO_SANDBOXED: '1',
      },
    },
  );
  const calls = existsSync(records)
    ? readFileSync(records, 'utf8').trim().split('\n').filter(Boolean).length
    : 0;
  console.log(JSON.stringify({ fixtureTestExit: result.status, syntheticHelperCalls: calls }));
  if (result.status !== 0 || calls !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
