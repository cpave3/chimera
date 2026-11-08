import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_MS,
  startBackgroundUpdates,
  updateStatus,
} from '../src/background-updates';
import { Updater } from '../src/updater';
import { fakeBinary, fakeGitHub } from './fixtures/fake-github';

describe('background updates', () => {
  let dir: string;
  let server: Server | undefined;
  let stop: (() => void) | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chimera-background-'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });
  afterEach(async () => {
    stop?.();
    vi.useRealTimers();
    server?.close();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function setup(current: string, mode: 'auto' | 'ask' | 'off', env: NodeJS.ProcessEnv = {}) {
    const github = await fakeGitHub([{ version: 'v1.2.0' }]);
    server = github.server;
    const executable = join(dir, 'chimera');
    await writeFile(executable, fakeBinary(current), { mode: 0o755 });
    const updater = new Updater({ api: github.api, current, executable });
    const notices: string[] = [];
    stop = startBackgroundUpdates({
      mode,
      updater,
      env,
      onNotice: (notice) => notices.push(notice),
    });
    const releaseChecks = () =>
      github.requests.filter((path) => path.endsWith('/releases/latest')).length;
    return { updater, notices, executable, releaseChecks };
  }

  /** Move the clock and let the network and the install finish. */
  async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('first checks a minute after start, then every six hours', async () => {
    const { releaseChecks } = await setup('v1.2.0', 'ask');
    await advance(FIRST_CHECK_MS - 1_000);
    expect(releaseChecks()).toBe(0);
    await advance(1_000);
    await vi.waitFor(() => expect(releaseChecks()).toBe(1));
    await advance(CHECK_INTERVAL_MS - 1_000);
    expect(releaseChecks()).toBe(1);
    await advance(1_000);
    await vi.waitFor(() => expect(releaseChecks()).toBe(2));
  });

  it('installs in auto mode and says to restart', async () => {
    const { notices, executable, updater } = await setup('v1.1.0', 'auto');
    await advance(FIRST_CHECK_MS);
    await vi.waitFor(() => expect(notices).toEqual(['updated to v1.2.0, restart to use']), {
      timeout: 5_000,
    });
    expect(await readFile(executable, 'utf8')).toContain('v1.2.0');
    expect(updater.state).toBe('installed');
    expect(updateStatus(updater)).toBe('v1.2.0 installed, restart');
  });

  it('only says a release is available in ask mode', async () => {
    const { notices, executable, updater } = await setup('v1.1.0', 'ask');
    await advance(FIRST_CHECK_MS);
    await vi.waitFor(() => expect(notices).toEqual(['v1.2.0 available · chimera update']));
    expect(await readFile(executable, 'utf8')).toContain('v1.1.0');
    expect(updateStatus(updater)).toBe('v1.2.0 available');
  });

  it.each([
    ['off', 'v1.1.0', {}],
    ['a dev build', 'dev', {}],
    ['CI', 'v1.1.0', { CI: 'true' }],
  ] as const)('never checks with %s', async (_case, current, env) => {
    const mode = _case === 'off' ? 'off' : 'auto';
    const { releaseChecks, notices } = await setup(current, mode, env);
    await advance(FIRST_CHECK_MS + CHECK_INTERVAL_MS);
    expect(releaseChecks()).toBe(0);
    expect(notices).toEqual([]);
  });
});
