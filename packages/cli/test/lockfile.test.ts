import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
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

  it('publishes complete lockfiles atomically while a discovery process reads them', async () => {
    const lock = {
      pid: process.pid,
      port: 12345,
      cwd: 'x'.repeat(100_000),
      sessionId: 'first',
      parentId: 'parent',
      startedAt: 1,
      version: 'test',
      url: 'http://localhost:12345',
    };
    writeLockfile(lock as never, home);
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const {readFileSync} = require('node:fs');
      const path = process.argv[1];
      process.stdout.write('ready\\n');
      const end = Date.now() + 500;
      let reads = 0;
      while (Date.now() < end) {
        try { JSON.parse(readFileSync(path, 'utf8')); reads++; }
        catch (error) { process.stderr.write(error.message); process.exit(1); }
      }
      process.stdout.write(String(reads));
    `,
        lockfilePath(process.pid, home),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let error = '';
    child.stderr.on('data', (chunk) => {
      error += chunk;
    });
    await new Promise<void>((resolve) =>
      child.stdout.once('data', (chunk) => {
        output += chunk;
        resolve();
      }),
    );
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    for (let index = 0; index < 500; index++) {
      writeLockfile({ ...lock, sessionId: `session-${index}` } as never, home);
    }
    expect(await exited, error).toBe(0);
    expect(Number(output.split('\n')[1])).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(lockfilePath(process.pid, home), 'utf8'))).toMatchObject({
      sessionId: 'session-499',
      parentId: 'parent',
    });
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

    it('preserves a live protected instance when the API returns 404 without its secret', async () => {
      const { url, port } = await listen((respond) => respond(404, { error: 'not found' }));
      lock(REUSED_PID, url, port);

      expect(await listVerifiedInstances({ home })).toMatchObject([
        { pid: REUSED_PID, responsive: false },
      ]);
      expect(existsSync(lockfilePath(REUSED_PID, home))).toBe(true);
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
    it('removes the lockfile without bypassing the signal owner’s asynchronous cleanup', async () => {
      // The home comes through the environment and is checked before anything
      // is written: a child that missed it would write into the real home.
      // Compiled to JS first: Node 20 cannot import a .ts file.
      const modulePath = join(home, 'lockfile.mjs');
      const source = await readFile(new URL('../src/lockfile.ts', import.meta.url), 'utf8');
      const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      await writeFile(modulePath, compiled.outputText);
      const script = `
        import { writeLockfile, removeLockfileOnExit } from ${JSON.stringify(pathToFileURL(modulePath).href)};
        const home = process.env.LOCKFILE_TEST_HOME;
        if (!home) process.exit(2);
        writeLockfile({ pid: process.pid, port: 1, cwd: '/tmp', startedAt: 0, version: '0', url: 'http://127.0.0.1:1' }, home);
        removeLockfileOnExit(process.pid, home);
        process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50));
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

        expect(await exited).toBe(0);
        expect(existsSync(lockfilePath(pid, home))).toBe(false);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });
});
