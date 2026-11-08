import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runUpdate } from '../src/commands/update';
import { type FakeRelease, fakeBinary, fakeGitHub } from './fixtures/fake-github';

describe('chimera update', () => {
  let dir: string;
  let server: Server | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chimera-update-'));
  });
  afterEach(async () => {
    server?.close();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** An installed binary of `version`, and how to run `chimera update` as it. */
  async function installed(version: string, releases: FakeRelease[]) {
    const github = await fakeGitHub(releases);
    server = github.server;
    const executable = join(dir, 'chimera');
    await writeFile(executable, fakeBinary(version), { mode: 0o755 });
    const output: string[] = [];
    const update = (options: Parameters<typeof runUpdate>[0]) =>
      runUpdate(
        options,
        { write: (text) => output.push(text) },
        { api: github.api, current: version, executable },
      );
    return { executable, output, update, requests: github.requests };
  }

  const reports = async (path: string) =>
    (await readFile(path, 'utf8')).match(/"version":"([^"]+)"/)?.[1];

  it('says when it is up to date, and changes nothing', async () => {
    const { executable, output, update } = await installed('v1.2.0', [
      { version: 'v1.1.0' },
      { version: 'v1.2.0' },
    ]);
    await update({});
    expect(output.join('')).toBe('chimera v1.2.0 is up to date (newest release: v1.2.0)\n');
    expect(await reports(executable)).toBe('v1.2.0');
  });

  it('reports a newer release with --check, without installing it', async () => {
    const { executable, output, update } = await installed('v1.1.0', [{ version: 'v1.2.0' }]);
    await update({ check: true });
    expect(output.join('')).toMatch(
      /^chimera v1\.1\.0 is installed; v1\.2\.0 is available: https:\/\/github\.com\/cpave3\/chimera\/releases\/tag\/v1\.2\.0\n/,
    );
    expect(await reports(executable)).toBe('v1.1.0');
  });

  it('prints the st contract with --json: current, latest, available, url, and updated on install', async () => {
    const check = await installed('v1.1.0', [{ version: 'v1.2.0' }]);
    await check.update({ check: true, json: true });
    expect(JSON.parse(check.output.join(''))).toEqual({
      current: 'v1.1.0',
      latest: 'v1.2.0',
      available: true,
      url: 'https://github.com/cpave3/chimera/releases/tag/v1.2.0',
    });
    check.output.length = 0;
    await check.update({ json: true });
    expect(Object.keys(JSON.parse(check.output.join('')))).toEqual([
      'current',
      'latest',
      'available',
      'url',
      'updated',
    ]);
    expect(JSON.parse(check.output.join('')).updated).toBe(true);
  });

  it('installs the newest release over the binary, leaving nothing beside it', async () => {
    const { executable, output, update } = await installed('v1.1.0', [{ version: 'v1.2.0' }]);
    await update({});
    expect(await reports(executable)).toBe('v1.2.0');
    expect(output.join('')).toMatch(/^Updated chimera v1\.1\.0 to v1\.2\.0/);
    expect(await readdir(dir)).toEqual(['chimera']);
  });

  it('leaves the binary alone when the download does not match SHA256SUMS', async () => {
    const { executable, update } = await installed('v1.1.0', [
      { version: 'v1.2.0', badChecksum: true },
    ]);
    await expect(update({})).rejects.toThrow(/does not match its checksum/);
    expect(await reports(executable)).toBe('v1.1.0');
    expect(await readdir(dir)).toEqual(['chimera']);
  });

  it('leaves the binary alone when the new binary reports another version', async () => {
    const { executable, update } = await installed('v1.1.0', [
      { version: 'v1.2.0', reports: 'v1.1.9' },
    ]);
    await expect(update({})).rejects.toThrow(/reports v1\.1\.9, not v1\.2\.0/);
    expect(await reports(executable)).toBe('v1.1.0');
    expect(await readdir(dir)).toEqual(['chimera']);
  });

  it('installs a pinned release with --version, even an older one', async () => {
    const { executable, requests, update } = await installed('v1.2.0', [
      { version: 'v1.1.0' },
      { version: 'v1.2.0' },
    ]);
    await update({ version: 'v1.1.0' });
    expect(await reports(executable)).toBe('v1.1.0');
    expect(requests).toContain('/repos/cpave3/chimera/releases/tags/v1.1.0');
  });

  it('follows a symlinked install and replaces the file it leads to', async () => {
    const { executable, update } = await installed('v1.1.0', [{ version: 'v1.2.0' }]);
    await mkdir(join(dir, 'bin'));
    const link = join(dir, 'bin', 'chimera');
    await symlink(executable, link);
    const output: string[] = [];
    await runUpdate(
      {},
      { write: (text) => output.push(text) },
      {
        api: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`,
        current: 'v1.1.0',
        executable: link,
      },
    );
    expect(await reports(executable)).toBe('v1.2.0');
    expect((await readFile(link, 'utf8')).includes('v1.2.0')).toBe(true);
  });

  it('refuses to install over a build from source, but still checks', async () => {
    const { executable, output, update } = await installed('dev', [{ version: 'v1.2.0' }]);
    await expect(update({})).rejects.toThrow(/built from a checkout.*pnpm -r build/);
    expect(await reports(executable)).toBe('dev');
    await update({ check: true });
    expect(output.join('')).toMatch(
      /chimera dev is not a release build; the newest release is v1\.2\.0/,
    );
  });
});

const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js');

describe.skipIf(!existsSync(BIN))('chimera update from the built CLI', () => {
  it('refuses to update a dev build, exiting non-zero', () => {
    const result = spawnSync(process.execPath, [BIN, 'update'], {
      encoding: 'utf8',
      env: { ...process.env, CHIMERA_RELEASES_API: 'http://127.0.0.1:9' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/built from a checkout/);
  });
});
