import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChimeraClient } from '@chimera/client';
import { afterEach, expect, it, vi } from 'vitest';
import { spawnChimeraChild } from '../../subagents/src/spawn-child';

const children: ChildProcess[] = [];
let home: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }),
  );
  if (home) await rm(home, { recursive: true, force: true });
});

async function configureHome(baseUrl = 'http://127.0.0.1:1') {
  home = await mkdtemp(join(tmpdir(), 'chimera-secret-'));
  await mkdir(join(home, '.chimera'));
  await writeFile(
    join(home, '.chimera/config.json'),
    JSON.stringify({
      providers: { fake: { shape: 'openai', baseUrl, apiKey: 'unused' } },
      defaultModel: 'fake/test',
      updates: { mode: 'off' },
    }),
  );
}

it('built serve protects its API without exposing the secret in its lockfile or argv', async () => {
  await configureHome();
  const scriptPath = join(home, 'script.json');
  await writeFile(
    scriptPath,
    JSON.stringify([
      {
        tool: 'bash',
        args: { command: `printf "%s" "\${CHIMERA_SERVER_SECRET-unset}" > secret-observed` },
      },
      { text: 'done' },
    ]),
  );
  const modelServer = spawn(
    process.execPath,
    [new URL('./fixtures/fake-model-server.mjs', import.meta.url).pathname, scriptPath],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  children.push(modelServer);
  const [ready] = await once(modelServer.stdout!, 'data');
  const modelPort = String(ready).trim().split(' ')[1];
  await writeFile(
    join(home, '.chimera/config.json'),
    JSON.stringify({
      providers: {
        fake: { shape: 'openai', baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'unused' },
      },
      defaultModel: 'fake/test',
      updates: { mode: 'off' },
    }),
  );
  const secret = 'test-private-token';
  const child = spawn(
    process.execPath,
    [
      new URL('../dist/bin.js', import.meta.url).pathname,
      'serve',
      '--machine-handshake',
      '--cwd',
      home,
    ],
    {
      env: { ...process.env, HOME: home, CHIMERA_SERVER_SECRET: secret },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let output = '';
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += chunk;
  });
  const handshake = await new Promise<{ url: string; pid: number; sessionId: string }>(
    (resolve, reject) => {
      child.stdout!.on('data', (chunk) => {
        output += chunk;
        if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]!));
      });
      child.once('exit', () => reject(new Error(stderr)));
    },
  );
  expect(new URL(handshake.url).pathname).toBe(`/${secret}`);
  expect((await fetch(`${new URL(handshake.url).origin}/v1/instance`)).status).toBe(404);
  expect((await new ChimeraClient({ baseUrl: handshake.url }).getInstance()).pid).toBe(child.pid);
  const lock = await readFile(join(home, '.chimera/instances', `${child.pid}.json`), 'utf8');
  expect(lock).not.toContain(secret);
  expect(child.spawnargs.join(' ')).not.toContain(secret);
  const attachArgs = [
    new URL('../dist/bin.js', import.meta.url).pathname,
    'attach',
    String(child.pid),
    '--inline',
  ];
  const refused = spawn(process.execPath, attachArgs, {
    env: { ...process.env, HOME: home, CHIMERA_SERVER_SECRET: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(refused);
  let refusal = '';
  refused.stderr!.on('data', (chunk) => {
    refusal += chunk;
  });
  expect((await once(refused, 'exit'))[0]).toBe(1);
  expect(refusal).toContain('404');
  const attached = spawn(process.execPath, attachArgs, {
    env: { ...process.env, HOME: home, CHIMERA_SERVER_SECRET: secret },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(attached);
  await new Promise<void>((resolve, reject) => {
    let screen = '';
    attached.stdout!.on('data', (chunk) => {
      screen += chunk;
      if (screen.includes('fake/test')) resolve();
    });
    attached.once('exit', (code) => reject(new Error(`attach exited ${code}: ${screen}`)));
  });
  const client = new ChimeraClient({ baseUrl: handshake.url });
  for await (const _event of client.send(handshake.sessionId, 'check environment')) {
    // Drain the run through the same client transport used by the TUI.
  }
  expect(await readFile(join(home, 'secret-observed'), 'utf8')).toBe('unset');
  const run = spawn(
    process.execPath,
    [new URL('../dist/bin.js', import.meta.url).pathname, 'run', '--cwd', home, 'hello'],
    {
      env: { ...process.env, HOME: home, CHIMERA_SERVER_SECRET: secret },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(run);
  let answer = '';
  run.stdout!.on('data', (chunk) => {
    answer += chunk;
  });
  expect((await once(run, 'exit'))[0]).toBe(0);
  expect(answer).toContain('done');
  const interactive = spawn(
    process.execPath,
    [new URL('../dist/bin.js', import.meta.url).pathname, '--cwd', home, '--inline'],
    {
      env: { ...process.env, HOME: home, CHIMERA_SERVER_SECRET: secret },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.push(interactive);
  await new Promise<void>((resolve, reject) => {
    let screen = '';
    interactive.stdout!.on('data', (chunk) => {
      screen += chunk;
      if (screen.includes('fake/test')) resolve();
    });
    interactive.once('exit', (code) => reject(new Error(`interactive exited ${code}: ${screen}`)));
  });
  const interactiveLock = JSON.parse(
    await readFile(join(home, '.chimera/instances', `${interactive.pid}.json`), 'utf8'),
  ) as { url: string };
  expect(new URL(interactiveLock.url).pathname).toBe('/');
  expect(
    (await new ChimeraClient({ baseUrl: `${interactiveLock.url}/${secret}` }).getInstance()).pid,
  ).toBe(interactive.pid);
}, 30_000);

it('spawned children use fresh secrets and their parent reaches the protected API', async () => {
  await configureHome();
  vi.stubEnv('HOME', home);
  vi.stubEnv('CHIMERA_SERVER_SECRET', 'parent-secret');
  const urls: string[] = [];
  for (let index = 0; index < 2; index++) {
    const handle = await spawnChimeraChild({
      chimeraBin: process.execPath,
      chimeraBinArgs: [new URL('../dist/bin.js', import.meta.url).pathname],
      cwd: home,
      parentSessionId: 'parent-session' as never,
      autoApprove: 'host',
      sandbox: false,
      parentHasTty: false,
    });
    children.push(handle.proc);
    urls.push(new URL(handle.url).pathname);
    expect((await handle.client.getInstance()).pid).toBe(handle.pid);
    expect((await fetch(`${new URL(handle.url).origin}/v1/instance`)).status).toBe(404);
    expect(handle.proc.spawnargs.join(' ')).not.toContain(new URL(handle.url).pathname.slice(1));
  }
  expect(urls[0]).not.toBe('/parent-secret');
  expect(urls[0]).not.toBe(urls[1]);
}, 30_000);
