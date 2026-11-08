import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBinary } from './fixtures/fake-github';

const INSTALL_SH = join(import.meta.dirname, '..', '..', '..', 'install.sh');
const SHELLCHECK = join(process.env.HOME ?? '', '.cache', 'tools', 'shellcheck');

/** A release's `latest/download` directory: one file per name. */
async function fakeDownloads(
  files: Record<string, string>,
): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    const name = (request.url ?? '').replace(/^\/latest\/download\//, '');
    const body = files[name];
    if (body === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}/latest/download` };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('install.sh', () => {
  let dir: string;
  let home: string;
  let fakeBin: string;
  let server: Server | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chimera-install-'));
    home = join(dir, 'home');
    fakeBin = join(dir, 'fake-bin');
    await mkdir(home);
    await mkdir(fakeBin);
  });
  afterEach(async () => {
    server?.close();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** `uname -s` and `uname -m` answer as this machine would. */
  async function pretendToBe(system: string, machine: string) {
    const uname = join(fakeBin, 'uname');
    await writeFile(
      uname,
      `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; *) echo ${system} ;; esac\n`,
    );
    await chmod(uname, 0o755);
  }

  function install(base: string, path = `${fakeBin}:${process.env.PATH}`) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        'sh',
        [INSTALL_SH],
        { env: { PATH: path, HOME: home, CHIMERA_INSTALL_BASE_URL: base } },
        (error, stdout, stderr) =>
          resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
      );
    });
  }

  it('installs the linux-amd64 binary to ~/.local/bin after checking SHA256SUMS', async () => {
    await pretendToBe('Linux', 'x86_64');
    const binary = fakeBinary('v1.2.0');
    const downloads = await fakeDownloads({
      'chimera-linux-amd64': binary,
      SHA256SUMS: `${sha256('other')}  chimera-linux-arm64\n${sha256(binary)}  chimera-linux-amd64\n`,
    });
    server = downloads.server;
    const result = await install(downloads.base);
    expect(result.code).toBe(0);
    const target = join(home, '.local', 'bin', 'chimera');
    expect(await readFile(target, 'utf8')).toBe(binary);
    expect(result.stdout).toMatch(/Installed chimera v1\.2\.0 to .*\.local\/bin\/chimera/);
    // ~/.local/bin is not on the PATH the script ran with.
    expect(result.stderr).toMatch(/\.local\/bin is not on your PATH/);
  });

  it('does not warn about PATH when ~/.local/bin is on it', async () => {
    await pretendToBe('Linux', 'x86_64');
    const binary = fakeBinary('v1.2.0');
    const downloads = await fakeDownloads({
      'chimera-linux-amd64': binary,
      SHA256SUMS: `${sha256(binary)}  chimera-linux-amd64\n`,
    });
    server = downloads.server;
    const result = await install(
      downloads.base,
      `${fakeBin}:${join(home, '.local', 'bin')}:${process.env.PATH}`,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).not.toMatch(/not on your PATH/);
  });

  it('aborts on a checksum mismatch and installs nothing', async () => {
    await pretendToBe('Linux', 'x86_64');
    const downloads = await fakeDownloads({
      'chimera-linux-amd64': fakeBinary('v1.2.0'),
      SHA256SUMS: `${sha256('something else')}  chimera-linux-amd64\n`,
    });
    server = downloads.server;
    const result = await install(downloads.base);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/checksum/i);
    expect(await readdir(join(home, '.local', 'bin'))).toEqual([]);
  });

  it('names the platforms it supports for any other OS or CPU', async () => {
    await pretendToBe('Darwin', 'x86_64');
    const result = await install('http://127.0.0.1:9/latest/download');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(
      /darwin x86_64 is not supported.*linux x86_64, linux aarch64, darwin arm64/,
    );
  });

  it.skipIf(!existsSync(SHELLCHECK))('passes shellcheck', async () => {
    const result = await new Promise<{ code: number; output: string }>((resolve) => {
      execFile(SHELLCHECK, ['--shell=sh', INSTALL_SH], (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, output: stdout + stderr }),
      );
    });
    expect(result.output).toBe('');
    expect(result.code).toBe(0);
  });
});
