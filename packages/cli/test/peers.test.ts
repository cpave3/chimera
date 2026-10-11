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

  it('names every other live instance with its mode and what it is doing', async () => {
    lock(process.pid, '/work/chimera', '01SELFSELFSELFSELFSELFSELF', 4001);
    lock(OTHER_PID, '/work/api', '01OTHEROTHEROTHEROTHER0001', 4002);
    const requested: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ status: 'running', mode: 'plan', cwd: '/work/api' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const peers = await listPeers({ home, selfPid: process.pid, fetch: fakeFetch });

    expect(peers).toEqual([{ label: 'api', mode: 'plan', status: 'running' }]);
    expect(requested).toEqual([
      'http://127.0.0.1:4002/v1/sessions/01OTHEROTHEROTHEROTHER0001/status',
    ]);
  });

  it('still lists an instance that does not answer', async () => {
    lock(OTHER_PID, '/work/api', '01OTHEROTHEROTHEROTHER0001', 4002);
    const refuse = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;

    expect(await listPeers({ home, selfPid: process.pid, fetch: refuse })).toEqual([
      { label: 'api' },
    ]);
  });

  it('is empty when this is the only instance', async () => {
    lock(process.pid, '/work/chimera', '01SELFSELFSELFSELFSELFSELF', 4001);
    expect(await listPeers({ home, selfPid: process.pid })).toEqual([]);
  });
});
