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
