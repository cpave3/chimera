import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { expect, it } from 'vitest';

it('runs fixtures and their children without the launching agent identity or extension environment', () => {
  expect(basename(homedir())).toBe('home');
  expect(homedir()).toContain('chimera-test-env-');
  const forbidden = [
    'CHIMERA_MOD_DIRS',
    'LEGATO_TASK_ID',
    'LEGATO_EXECUTION_ID',
    'LEGATO_BIN',
    'LEGATO_BROKER_SOCKET',
    'LEGATO_BROKER_TOKEN',
    'LEGATO_SANDBOXED',
    'LEGATO_CONFIG',
    'BASH_ENV',
    'ZDOTDIR',
    'CHIMERA_SERVER_SECRET',
  ];
  for (const key of forbidden) expect(process.env[key], key).toBeUndefined();
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const forbidden = ${JSON.stringify(forbidden)};
    process.stdout.write(JSON.stringify({
      isolatedHome: require('node:os').homedir().includes('chimera-test-env-'),
      inherited: forbidden.filter(key => process.env[key] !== undefined),
    }));
  `,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  );
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ isolatedHome: true, inherited: [] });
});
