import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareVersions, isNewer, isRelease, stampedVersion, versionReport } from '../src/version';

describe('the version', () => {
  it('is dev without a stamp, and the stamp otherwise', () => {
    expect(stampedVersion(undefined)).toBe('dev');
    expect(stampedVersion('')).toBe('dev');
    expect(stampedVersion('v1.2.3')).toBe('v1.2.3');
  });

  it('is a release for a stable vX.Y.Z only', () => {
    expect(isRelease('v1.2.3')).toBe(true);
    expect(isRelease('v0.10.0')).toBe(true);
    expect(isRelease('dev')).toBe(false);
    expect(isRelease('v1.2.3-rc.1')).toBe(false);
    expect(isRelease('1.2.3')).toBe(false);
    expect(isRelease('v01.2.3')).toBe(false);
    expect(versionReport('v1.2.3')).toEqual({ version: 'v1.2.3', release: true, modApi: [1] });
    expect(versionReport('dev')).toEqual({ version: 'dev', release: false, modApi: [1] });
  });

  it('compares components as numbers', () => {
    expect(compareVersions('v0.10.0', 'v0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.9.9', 'v0.10.0')).toBeLessThan(0);
    expect(compareVersions('v1.2.3', 'v1.2.3')).toBe(0);
    expect(compareVersions('v2.0.0', 'v1.99.99')).toBeGreaterThan(0);
  });

  it('never takes dev or a prerelease as newer', () => {
    expect(isNewer('dev', 'v0.0.1')).toBe(false);
    expect(isNewer('v1.0.0-rc.1', 'v0.9.0')).toBe(false);
    expect(isNewer('v0.0.1', 'dev')).toBe(true);
    expect(isNewer('v1.2.3', 'v1.2.3')).toBe(false);
  });
});

const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js');

const hasBun = spawnSync('bun', ['--version']).status === 0;

describe.skipIf(!existsSync(BIN))('chimera version', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-version-'));
  });
  afterEach(async () => {
    await chmod(join(home, '.chimera', 'config.json'), 0o600).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });

  const chimera = (...args: string[]) =>
    spawnSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });

  it('says dev for a build from source', () => {
    expect(chimera('--version').stdout.trim()).toBe('dev');
    const json = chimera('version', '--json');
    expect(json.status).toBe(0);
    expect(json.stdout.trim()).toBe('{"version":"dev","release":false,"modApi":[1]}');
    expect(chimera('version').stdout.trim()).toBe('dev');
  });

  it('reads no configuration, so an unreadable config.json does not stop it', async () => {
    await mkdir(join(home, '.chimera'));
    await writeFile(join(home, '.chimera', 'config.json'), '{ not json');
    await chmod(join(home, '.chimera', 'config.json'), 0o000);
    const json = chimera('version', '--json');
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ version: 'dev', release: false, modApi: [1] });
  });

  it.skipIf(!hasBun)('reports the stamped version of a build made with the define', async () => {
    const entry = join(home, 'entry.ts');
    const versionModule = join(import.meta.dirname, '..', 'src', 'version.ts');
    await writeFile(
      entry,
      `import { versionReport } from '${versionModule}';\nconsole.log(JSON.stringify(versionReport()));\n`,
    );
    const out = join(home, 'stamped.mjs');
    const build = spawnSync(
      'bun',
      [
        'build',
        entry,
        '--target=node',
        `--outfile=${out}`,
        '--define',
        '__CHIMERA_VERSION__="v1.2.3"',
      ],
      { encoding: 'utf8' },
    );
    expect(build.status, build.stderr).toBe(0);
    const run = spawnSync(process.execPath, [out], { encoding: 'utf8' });
    expect(JSON.parse(run.stdout)).toEqual({ version: 'v1.2.3', release: true, modApi: [1] });
  });
});
