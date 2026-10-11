import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLockfile } from '../src/lockfile';
import { listPeers } from '../src/peers';

// A live process that is not this one stands in for another instance.
const OTHER_PID = process.ppid;

describe('listPeers', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-peers-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const lock = (pid: number, cwd: string, sessionId: string, port: number) =>
    writeLockfile(
      {
        pid,
        port,
        cwd,
        sessionId,
        startedAt: Date.now(),
        version: '0.1.0',
        url: `http://127.0.0.1:${port}`,
      },
      home,
    );

  /** Answers the identity question for each lockfile, and the status question as the test says. */
  function instances(
    pids: Record<string, number>,
    status: (url: string) => Response | Promise<Response>,
  ) {
    const requested: string[] = [];
    const fake = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/v1/instance')) {
        const port = new URL(url).port;
        return new Response(JSON.stringify({ pid: pids[port] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return status(url);
    }) as typeof fetch;
    return { fake, requested };
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('names every other live instance with its mode and what it is doing', async () => {
    lock(process.pid, '/work/chimera', '01SELFSELFSELFSELFSELFSELF', 4001);
    lock(OTHER_PID, '/work/api', '01OTHEROTHEROTHEROTHER0001', 4002);
    const { fake, requested } = instances({ 4001: process.pid, 4002: OTHER_PID }, () =>
      json({ status: 'running', mode: 'plan', cwd: '/work/api' }),
    );

    const peers = await listPeers({ home, selfPid: process.pid, fetch: fake });

    expect(peers).toEqual([{ label: 'api', mode: 'plan', status: 'running' }]);
    expect(requested).toContain(
      'http://127.0.0.1:4002/v1/sessions/01OTHEROTHEROTHEROTHER0001/status',
    );
  });

  it('leaves out a lockfile whose instance is gone, though its PID is in use again', async () => {
    lock(OTHER_PID, '/work/api', '01OTHEROTHEROTHEROTHER0001', 4002);
    const refuse = (async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4002'), {
          code: 'ECONNREFUSED',
        }),
      });
    }) as typeof fetch;

    expect(await listPeers({ home, selfPid: process.pid, fetch: refuse })).toEqual([]);
    // The lockfile is cleaned up, so the next look does not ask again.
    expect(await listPeers({ home, selfPid: process.pid, fetch: refuse })).toEqual([]);
  });

  it('lists an instance that is too busy to answer, without a state', async () => {
    lock(OTHER_PID, '/work/api', '01OTHEROTHEROTHEROTHER0001', 4002);
    const slow = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as typeof fetch;

    expect(await listPeers({ home, selfPid: process.pid, fetch: slow })).toEqual([
      { label: 'api' },
    ]);
  });

  it('lists an instance on an older build, which has no status to give', async () => {
    lock(OTHER_PID, '/work/api', '01OTHEROTHEROTHEROTHER0001', 4002);
    const { fake } = instances({ 4002: OTHER_PID }, () => json({ error: 'not found' }, 404));

    expect(await listPeers({ home, selfPid: process.pid, fetch: fake })).toEqual([
      { label: 'api' },
    ]);
  });

  it('is empty when this is the only instance', async () => {
    lock(process.pid, '/work/chimera', '01SELFSELFSELFSELFSELFSELF', 4001);
    const { fake } = instances({ 4001: process.pid }, () => json({}));

    expect(await listPeers({ home, selfPid: process.pid, fetch: fake })).toEqual([]);
  });
});
