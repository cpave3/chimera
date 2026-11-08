import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assetName } from '../../src/updater';

const ASSET = assetName();

/** A program that answers `version --json` as a Chimera of `version` would. */
export function fakeBinary(version: string): string {
  return `#!/bin/sh\necho '{"version":"${version}","release":true}'\n`;
}

export interface FakeRelease {
  version: string;
  /** What the binary reports, when it should differ from the release. */
  reports?: string;
  /** A checksum that does not match the binary. */
  badChecksum?: boolean;
}

/** GitHub's API and download addresses for a list of releases; the last is "latest". */
export async function fakeGitHub(
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
