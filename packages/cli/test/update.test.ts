import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runUpdate } from '../src/commands/update';
import { assetName } from '../src/updater';

const ASSET = assetName();

/** A program that answers `version --json` as a Chimera of `version` would. */
function fakeBinary(version: string): string {
  return `#!/bin/sh\necho '{"version":"${version}","release":true}'\n`;
}

interface FakeRelease {
  version: string;
  /** What the binary reports, when it should differ from the release. */
  reports?: string;
  /** A checksum that does not match the binary. */
  badChecksum?: boolean;
}

/** GitHub's API and download addresses for a list of releases; the last is "latest". */
async function fakeGitHub(
  releases: FakeRelease[],
): Promise<{ server: Server; api: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push(path);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const release = (tag: string) => releases.find((candidate) => candidate.version === tag);
    const describe = (entry: FakeRelease) => ({
      tag_name: entry.version,
      html_url: `https://github.com/cpave3/chimera/releases/tag/${entry.version}`,
      draft: false,
      prerelease: false,
      assets: [ASSET, 'SHA256SUMS'].map((name) => ({
        name,
        browser_download_url: `${base}/download/${entry.version}/${name}`,
      })),
    });
    const latest = path.match(/^\/repos\/cpave3\/chimera\/releases\/latest$/);
    const tagged = path.match(/^\/repos\/cpave3\/chimera\/releases\/tags\/(.+)$/);
    const file = path.match(/^\/download\/([^/]+)\/(.+)$/);
    if (latest || tagged) {
      const entry = latest ? releases.at(-1) : release(decodeURIComponent(tagged![1]!));
      if (!entry) return void response.writeHead(404).end();
      response.writeHead(200, { 'content-type': 'application/json' });
      return void response.end(JSON.stringify(describe(entry)));
    }
    if (file) {
      const entry = release(file[1]!);
      if (!entry) return void response.writeHead(404).end();
      const binary = fakeBinary(entry.reports ?? entry.version);
      if (file[2] === ASSET) return void response.writeHead(200).end(binary);
      const sum = entry.badChecksum
        ? '0'.repeat(64)
        : createHash('sha256').update(binary).digest('hex');
      return void response
        .writeHead(200)
        .end(`${sum}  ${ASSET}\n${'1'.repeat(64)}  chimera-other-os\n`);
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

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
