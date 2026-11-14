import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/runtime-smoke.mjs', import.meta.url));
const expected = { seen: ['mjs', 'mts'], mods: ['loaded', 'loaded'] };

it('loads real .mjs and .mts through the built host under native Node', async () => {
  const { stdout } = await execute(process.execPath, [fixture]);
  expect(JSON.parse(stdout)).toEqual(expected);
});

it.skipIf(process.env.CHIMERA_TEST_MOD_BINARY !== '1')(
  'loads .mjs and .mts through a compiled host',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mod-binary-test-'));
    const binary = join(directory, 'mod-host');
    await execute('bun', [
      'build',
      '--compile',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      '--no-compile-autoload-tsconfig',
      '--outfile',
      binary,
      fixture,
    ]);
    const { stdout } = await execute(binary);
    expect(JSON.parse(stdout)).toEqual(expected);
  },
  30_000,
);

it('keeps Chimera alive when a real mod catches a helper stdin write failure', async () => {
  const processFixture = fileURLToPath(new URL('./fixtures/process-lifetime.mjs', import.meta.url));
  const { stdout } = await execute(process.execPath, [processFixture, 'epipe'], { timeout: 3000 });
  expect(JSON.parse(stdout).seen).toEqual(['rejected:EPIPE']);
});

it('stops a real mod helper’s descendants before returning from shutdown', async () => {
  const processFixture = fileURLToPath(new URL('./fixtures/process-lifetime.mjs', import.meta.url));
  const { stdout } = await execute(process.execPath, [processFixture, 'descendant'], {
    timeout: 3000,
  });
  const result = JSON.parse(stdout);
  expect(result.terminated).toBe('terminated');
  expect(result.elapsed).toBeLessThan(2500);
});

it('escalates to a TERM-ignoring descendant after its wrapper exits', async () => {
  const processFixture = fileURLToPath(new URL('./fixtures/process-lifetime.mjs', import.meta.url));
  const { stdout } = await execute(process.execPath, [processFixture, 'stubborn'], {
    timeout: 4500,
  });
  const result = JSON.parse(stdout);
  expect(result.terminated).toBe('terminated');
  expect(result.elapsed).toBeGreaterThanOrEqual(1900);
  expect(result.elapsed).toBeLessThan(2800);
});
