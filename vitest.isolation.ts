import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';

// A fixture can start a real CLI, mod or MCP helper. An inherited agent
// identity or extension path would let it act for the session running tests.
const retained = new Set([
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'CI',
  'NODE_ENV',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'CHIMERA_TEST_DOCKER',
  'CHIMERA_TEST_TMUX',
  'CHIMERA_TEST_E2E',
  'CHIMERA_TEST_SANDBOX_IMAGE',
]);
for (const key of Object.keys(process.env)) {
  if (!retained.has(key) && !key.startsWith('VITEST_')) delete process.env[key];
}
const root = mkdtempSync(join(tmpdir(), 'chimera-test-env-'));
for (const [key, folder] of Object.entries({
  HOME: 'home',
  USERPROFILE: 'home',
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_CACHE_HOME: 'cache',
  XDG_RUNTIME_DIR: 'run',
  TMUX_TMPDIR: 'tmux',
  LEGATO_HOME: 'legato',
})) {
  const path = join(root, folder);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  process.env[key] = path;
}
// Keep child `node` invocations on this runtime rather than a home-relative shim.
process.env.PATH =
  dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + process.env.PATH;
afterAll(() => rmSync(root, { recursive: true, force: true }));
