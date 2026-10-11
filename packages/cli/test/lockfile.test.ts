import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isPidAlive,
  listLiveInstances,
  listVerifiedInstances,
  lockfilePath,
  writeLockfile,
} from '../src/lockfile';

describe('lockfile', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-lock-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('isPidAlive returns true for current pid and false for a fake one', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // PID 2**30 is almost certainly unused.
    expect(isPidAlive(2 ** 30)).toBe(false);
  });

  it('writeLockfile creates the file and listLiveInstances returns it', () => {
    writeLockfile(
      {
        pid: process.pid,
        port: 12345,
        cwd: '/tmp',
        startedAt: Date.now(),
        version: '0.1.0',
        url: 'http://127.0.0.1:12345',
      },
      home,
    );
    expect(existsSync(lockfilePath(process.pid, home))).toBe(true);
    const instances = listLiveInstances(home);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.port).toBe(12345);
  });

  it('listLiveInstances cleans up stale lockfiles', () => {
    // Write a lockfile for a dead pid.
    writeLockfile(
      {
        pid: 2 ** 30,
        port: 999,
        cwd: '/tmp',
        startedAt: Date.now(),
        version: '0.1.0',
        url: 'http://127.0.0.1:999',
      },
      home,
    );
    expect(existsSync(lockfilePath(2 ** 30, home))).toBe(true);
    const instances = listLiveInstances(home);
    expect(instances).toHaveLength(0);
    expect(existsSync(lockfilePath(2 ** 30, home))).toBe(false);
  });

  describe('listVerifiedInstances', () => {
    // A live process that is not a Chimera instance: what a reused PID looks like.
    const REUSED_PID = process.ppid;
    const servers: Server[] = [];

    afterEach(async () => {
      await Promise.all(
        servers.splice(0).map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
    });

    /** A server that answers `/v1/instance` the way the handler says. */
    async function listen(
      handler: (respond: (status: number, body: unknown) => void) => void,
    ): Promise<{ url: string; port: number }> {
      const server = createServer((_request, response) => {
        handler((status, body) => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(body));
        });
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      return { url: `http://127.0.0.1:${port}`, port };
    }

    const lock = (pid: number, url: string, port: number) =>
      writeLockfile(
        { pid, port, cwd: '/work/app', startedAt: Date.now(), version: '0.1.0', url },
        home,
      );

    it('keeps an instance that answers as the process the lockfile names', async () => {
      const { url, port } = await listen((respond) =>
        respond(200, { pid: REUSED_PID, cwd: '/work/app' }),
      );
      lock(REUSED_PID, url, port);

      const instances = await listVerifiedInstances({ home });

      expect(instances).toMatchObject([{ pid: REUSED_PID, url, responsive: true }]);
    });

    it('drops a lockfile whose PID is alive but whose port refuses the connection', async () => {
      const { url, port } = await listen((respond) => respond(200, {}));
      await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
      lock(REUSED_PID, url, port);

      const instances = await listVerifiedInstances({ home });

      expect(instances).toEqual([]);
      expect(existsSync(lockfilePath(REUSED_PID, home))).toBe(false);
    });

    it('drops a lockfile whose port now belongs to another process', async () => {
      const { url, port } = await listen((respond) =>
        respond(200, { pid: 4242, cwd: '/elsewhere' }),
      );
      lock(REUSED_PID, url, port);

      expect(await listVerifiedInstances({ home })).toEqual([]);
      expect(existsSync(lockfilePath(REUSED_PID, home))).toBe(false);
    });

    it('drops a lockfile whose port is served by something that is not Chimera', async () => {
      const { url, port } = await listen((respond) => respond(404, { error: 'not found' }));
      lock(REUSED_PID, url, port);

      expect(await listVerifiedInstances({ home })).toEqual([]);
      expect(existsSync(lockfilePath(REUSED_PID, home))).toBe(false);
    });

    it('keeps an instance that is slow to answer, and its lockfile, as not responsive', async () => {
      const { url, port } = await listen(() => {
        // never answers
      });
      lock(REUSED_PID, url, port);

      const instances = await listVerifiedInstances({ home, timeoutMs: 100 });

      expect(instances).toMatchObject([{ pid: REUSED_PID, responsive: false }]);
      expect(existsSync(lockfilePath(REUSED_PID, home))).toBe(true);
    });

    it('drops a lockfile whose process is gone, without asking', async () => {
      lock(2 ** 30, 'http://127.0.0.1:1', 1);

      expect(await listVerifiedInstances({ home })).toEqual([]);
      expect(existsSync(lockfilePath(2 ** 30, home))).toBe(false);
    });
  });

  describe('removeLockfileOnExit', () => {
    it('removes the lockfile of a process that is told to terminate', async () => {
      // The home comes through the environment and is checked before anything
      // is written: a child that missed it would write into the real home.
      const script = `
        import { writeLockfile, removeLockfileOnExit } from ${JSON.stringify(new URL('../src/lockfile.ts', import.meta.url).href)};
        const home = process.env.LOCKFILE_TEST_HOME;
        if (!home) process.exit(2);
        writeLockfile({ pid: process.pid, port: 1, cwd: '/tmp', startedAt: 0, version: '0', url: 'http://127.0.0.1:1' }, home);
        removeLockfileOnExit(process.pid, home);
        process.stdout.write(String(process.pid) + '\\n');
        setInterval(() => {}, 1000);
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, LOCKFILE_TEST_HOME: home },
      });
      try {
        const pid = await new Promise<number>((resolve, reject) => {
          child.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
          child.once('exit', (code) => reject(new Error(`child exited early with ${code}`)));
        });
        expect(existsSync(lockfilePath(pid, home))).toBe(true);

        const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');

        expect(await exited).toBe(128 + 15);
        expect(existsSync(lockfilePath(pid, home))).toBe(false);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });
});
