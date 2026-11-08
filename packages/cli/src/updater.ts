import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isNewer, isRelease, VERSION } from './version';

/** Where Chimera's releases are published. */
export const RELEASE_REPO = 'cpave3/chimera';
/** Another address for GitHub's API, for tests. */
export const RELEASES_API_ENV = 'CHIMERA_RELEASES_API';
const GITHUB_API = 'https://api.github.com';
const SUMS_ASSET = 'SHA256SUMS';

export type UpdateState =
  | 'unchecked'
  | 'up_to_date'
  | 'available'
  | 'installing'
  | 'installed'
  | 'failed';

export interface Release {
  /** The release's tag, such as v1.2.3. */
  version: string;
  /** The release's page. */
  url: string;
  /** The release's files: name to download address. */
  assets: Record<string, string>;
}

/** What `chimera update --json` prints, field for field what `st update --json` prints. */
export interface UpdateReport {
  current: string;
  latest: string;
  available: boolean;
  url: string;
  /** Set by an install; left out by `--check`. */
  updated?: boolean;
}

export interface ReleaseSource {
  /** GitHub's API address; defaults to `CHIMERA_RELEASES_API`, then api.github.com. */
  api?: string;
  repo?: string;
  fetch?: typeof fetch;
}

function apiBase(source: ReleaseSource): string {
  return (source.api ?? process.env[RELEASES_API_ENV] ?? GITHUB_API).replace(/\/+$/, '');
}

async function readRelease(source: ReleaseSource, path: string, what: string): Promise<Release> {
  const response = await (source.fetch ?? fetch)(
    `${apiBase(source)}/repos/${source.repo ?? RELEASE_REPO}/releases/${path}`,
    { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } },
  );
  if (response.status === 404) throw new Error(`no ${what} of chimera has been published`);
  if (!response.ok)
    throw new Error(`GitHub answered ${response.status} for the ${what} of chimera`);
  const body = (await response.json()) as {
    tag_name: string;
    html_url: string;
    draft?: boolean;
    prerelease?: boolean;
    assets: Array<{ name: string; browser_download_url: string }>;
  };
  if (body.draft || body.prerelease) throw new Error(`${body.tag_name} is not a stable release`);
  return {
    version: body.tag_name,
    url: body.html_url,
    assets: Object.fromEntries(
      body.assets.map((asset) => [asset.name, asset.browser_download_url]),
    ),
  };
}

/** The newest stable release: GitHub's "latest", which is never a draft or a prerelease. Needs no token. */
export function latestRelease(source: ReleaseSource = {}): Promise<Release> {
  return readRelease(source, 'latest', 'release');
}

/** One release by its tag, for `--version`. */
export function releaseByTag(tag: string, source: ReleaseSource = {}): Promise<Release> {
  return readRelease(source, `tags/${encodeURIComponent(tag)}`, `release ${tag}`);
}

/** The release file of the binary for a platform: `chimera-<os>-<arch>`. */
export function assetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const cpu = arch === 'x64' ? 'amd64' : arch;
  return `chimera-${platform}-${cpu}`;
}

async function download(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The asset's SHA-256 in the release's SHA256SUMS. */
async function expectedChecksum(
  release: Release,
  asset: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const url = release.assets[SUMS_ASSET];
  if (!url)
    throw new Error(
      `release ${release.version} has no ${SUMS_ASSET} to check its checksum against`,
    );
  for (const line of (await download(url, fetchImpl)).toString('utf8').split('\n')) {
    const [sum, name] = line.trim().split(/\s+/);
    if (sum && name?.replace(/^\*/, '') === asset) return sum.toLowerCase();
  }
  throw new Error(`${SUMS_ASSET} has no checksum for ${asset}`);
}

/** Run `<binary> version --json`; it has to report `want`. */
function reportsVersion(binary: string, want: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['version', '--json'], { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(`running 'version --json' failed: ${String(stderr).trim() || error.message}`),
        );
        return;
      }
      let reported: { version?: string };
      try {
        reported = JSON.parse(String(stdout));
      } catch {
        reject(new Error(`'version --json' printed ${JSON.stringify(String(stdout).trim())}`));
        return;
      }
      if (reported.version !== want) {
        reject(new Error(`the downloaded binary reports ${reported.version}, not ${want}`));
        return;
      }
      resolve();
    });
  });
}

export interface InstallOptions {
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * Put the release's binary for this OS and CPU in place of `executable`,
 * following a link to the file it leads to. The binary is downloaded beside
 * that file, checked against SHA256SUMS, made executable, and run: it has
 * to report the release's version. Only then is it renamed over the file,
 * so a process still running the old binary goes on running it. Any failure
 * leaves the file as it was. No copy of the old binary is kept.
 */
export async function installRelease(
  release: Release,
  executable: string,
  options: InstallOptions = {},
): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const asset = assetName(options.platform, options.arch);
  const target = await realpath(executable);
  const url = release.assets[asset];
  if (!url) throw new Error(`release ${release.version} has no ${asset}`);
  const want = await expectedChecksum(release, asset, fetchImpl);
  const binary = await download(url, fetchImpl);
  const got = createHash('sha256').update(binary).digest('hex');
  if (got !== want) throw new Error(`${asset} of ${release.version} does not match its checksum`);
  const partial = join(dirname(target), `.${basename(target)}.update-${process.pid}-${Date.now()}`);
  try {
    const handle = await open(partial, 'wx', 0o755);
    try {
      await handle.writeFile(binary);
    } finally {
      await handle.close();
    }
    await chmod(partial, 0o755);
    await reportsVersion(partial, release.version);
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

export interface UpdaterOptions extends ReleaseSource, InstallOptions {
  /** The version running; the build's own by default. */
  current?: string;
  /** The binary to replace; this process's executable by default. */
  executable?: string;
}

/**
 * The updater's state for one running Chimera: what it last found and did.
 * `chimera update`, the TUI and `chimera serve` use it.
 */
export class Updater {
  state: UpdateState = 'unchecked';
  latest: Release | null = null;
  error: string | null = null;
  readonly current: string;

  constructor(private readonly options: UpdaterOptions = {}) {
    this.current = options.current ?? VERSION;
  }

  get release(): boolean {
    return isRelease(this.current);
  }

  /** Look for a newer release. Any build may look; only a release build installs. */
  async check(): Promise<UpdateReport> {
    try {
      const latest = await latestRelease(this.options);
      this.latest = latest;
      // A build from source cannot install a release, so none is on offer.
      const available = this.release && isNewer(latest.version, this.current);
      this.state = available ? 'available' : 'up_to_date';
      this.error = null;
      return { current: this.current, latest: latest.version, available, url: latest.url };
    } catch (error) {
      this.state = 'failed';
      this.error = (error as Error).message;
      throw error;
    }
  }

  /**
   * Install the newest release, or the one tagged `pinned` (which may be
   * older: a rollback). Refuses a build from source.
   */
  async install(pinned?: string): Promise<UpdateReport> {
    if (!this.release) {
      throw new Error(
        `this chimera (${this.current}) was built from a checkout, not downloaded from a release, so chimera update leaves it alone: rebuild it from the checkout (pnpm -r build)`,
      );
    }
    const release = pinned
      ? await releaseByTag(pinned, this.options)
      : await latestRelease(this.options);
    const available = pinned
      ? release.version !== this.current
      : isNewer(release.version, this.current);
    const report: UpdateReport = {
      current: this.current,
      latest: release.version,
      available,
      url: release.url,
      updated: false,
    };
    if (!available) {
      this.state = 'up_to_date';
      return report;
    }
    this.state = 'installing';
    try {
      await installRelease(release, this.options.executable ?? process.execPath, this.options);
    } catch (error) {
      this.state = 'failed';
      this.error = (error as Error).message;
      throw new Error(`installing chimera ${release.version}: ${this.error}`);
    }
    this.state = 'installed';
    this.latest = release;
    this.error = null;
    return { ...report, updated: true };
  }
}
