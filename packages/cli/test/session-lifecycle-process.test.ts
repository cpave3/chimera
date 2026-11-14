import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const BIN = new URL('../dist/bin.js', import.meta.url).pathname;
const RELEASE_BIN = process.env.CHIMERA_TEST_RELEASE_BIN;
let home: string;
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }),
  );
  if (home) await rm(home, { recursive: true, force: true });
});

async function configure(sleep = false) {
  home = await mkdtemp(join(tmpdir(), 'chimera-session-process-'));
  await mkdir(join(home, 'workspace'));
  await mkdir(join(home, '.chimera'), { recursive: true });
  await writeFile(
    join(home, '.chimera/config.json'),
    JSON.stringify({
      providers: { fake: { shape: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'unused' } },
      defaultModel: 'fake/test',
      models: { 'fake/test': { contextWindow: 200000 } },
      updates: { mode: 'off' },
      workspaceCheckpoints: false,
    }),
  );
  for (const event of ['SessionStart', 'SessionEnd']) {
    const directory = join(home, '.chimera/hooks', event);
    await mkdir(directory, { recursive: true });
    const script = join(directory, 'record.sh');
    await writeFile(
      script,
      `#!/bin/sh\npayload=$(cat)\nprintf '%s\\n' "$payload" >> ${JSON.stringify(join(home, 'events.jsonl'))}\n${sleep && event === 'SessionEnd' ? `case "$payload" in *'"reason":"switch"'*) ;; *) sleep 5 ;; esac` : ''}\n`,
    );
    await chmod(script, 0o755);
  }
}

async function events(): Promise<
  Array<{ event: string; session_id: string; reason: string; parentSessionId?: string }>
> {
  try {
    return (await readFile(join(home, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function until(check: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function launch(args: string[]) {
  const child = spawn(
    RELEASE_BIN ?? process.execPath,
    [...(RELEASE_BIN ? [] : [BIN]), ...args, '--cwd', join(home, 'workspace'), '--no-compaction'],
    {
      env: { ...process.env, HOME: home, CHIMERA_SERVER_SECRET: 'private-session-token' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let output = '';
  let errors = '';
  child.stdout!.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr!.on('data', (chunk) => {
    errors += chunk;
  });
  const exited = once(child, 'exit');
  return { child, exited, output: () => output, errors: () => errors };
}

it('built run ends its session without deleting the persisted conversation', async () => {
  await configure(true);
  const modelServer = spawn(
    process.execPath,
    [new URL('./fixtures/fake-model-server.mjs', import.meta.url).pathname],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  children.push(modelServer);
  const [ready] = await once(modelServer.stdout!, 'data');
  const port = String(ready).trim().split(' ')[1];
  const configPath = join(home, '.chimera/config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.providers.fake.baseUrl = `http://127.0.0.1:${port}/v1`;
  await writeFile(configPath, JSON.stringify(config));
  const run = launch(['run', 'hello']);
  expect((await run.exited)[0], run.errors()).toBe(0);
  const lifecycle = await events();
  expect(lifecycle.map((event) => [event.event, event.reason])).toEqual([
    ['SessionStart', 'new'],
    ['SessionEnd', 'exit'],
  ]);
  const sessionId = lifecycle[0]!.session_id;
  expect(
    await readFile(join(home, '.chimera/sessions', sessionId, 'events.jsonl'), 'utf8'),
  ).toContain('done');
}, 15000);

it.each([
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
] as const)('built serve ends sessions on %s within the shared shutdown window', async (signal) => {
  await configure(true);
  const process = launch(['serve', '--machine-handshake', '--parent', 'parent-session']);
  await until(() => process.output().includes('\n'), 'serve handshake');
  const handshake = JSON.parse(process.output().split('\n')[0]!);
  const lockPath = join(home, '.chimera/instances', `${process.child.pid}.json`);
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  expect(lock.parentId).toBe('parent-session');
  expect(lock.url).not.toContain('private-session-token');
  expect((await events())[0]).toMatchObject({
    reason: 'new',
    session_id: handshake.sessionId,
    parentSessionId: 'parent-session',
  });
  const switched = await fetch(`${handshake.url}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cwd: join(home, 'workspace'),
      model: { providerId: 'fake', modelId: 'test', maxSteps: 5 },
      previousSessionId: handshake.sessionId,
    }),
  });
  expect(switched.status).toBe(201);
  const { sessionId } = await switched.json();
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({
    sessionId,
    parentId: 'parent-session',
  });
  const started = Date.now();
  process.child.kill(signal);
  expect((await process.exited)[0], process.errors()).toBe(0);
  expect(Date.now() - started).toBeLessThan(3000);
  expect((await events()).at(-1)).toMatchObject({
    event: 'SessionEnd',
    session_id: sessionId,
    reason: signal === 'SIGINT' ? 'exit' : 'signal',
  });
}, 15000);

it.each([
  '/exit\r',
  '\x03\x03',
])('built interactive switches and rewrites the lockfile, then ends on %j', async (exitKeys) => {
  await configure(true);
  const process = launch(['--inline']);
  await until(() => process.output().includes('fake/test'), 'interactive mount');
  const lockPath = join(home, '.chimera/instances', `${process.child.pid}.json`);
  const lock = async () => JSON.parse(await readFile(lockPath, 'utf8'));
  const first = await lock();
  process.child.stdin!.write('/new\r');
  await until(async () => (await lock()).sessionId !== first.sessionId, 'new session lockfile');
  const second = await lock();
  process.child.stdin!.write('/fork alternative\r');
  await until(async () => (await lock()).sessionId !== second.sessionId, 'fork lockfile');
  const child = await lock();
  expect(child.parentId).toBe(second.sessionId);
  expect(child.url).not.toContain('private-session-token');
  const started = Date.now();
  process.child.stdin!.write(exitKeys);
  expect((await process.exited)[0], process.errors()).toBe(0);
  expect(Date.now() - started).toBeLessThan(3000);
  expect((await events()).map((event) => [event.event, event.session_id, event.reason])).toEqual([
    ['SessionStart', first.sessionId, 'new'],
    ['SessionEnd', first.sessionId, 'switch'],
    ['SessionStart', second.sessionId, 'switch'],
    ['SessionEnd', second.sessionId, 'switch'],
    ['SessionStart', child.sessionId, 'fork'],
    ['SessionEnd', child.sessionId, 'exit'],
  ]);
  for (const args of [['--session', child.sessionId], ['--continue']]) {
    const resumed = launch(['--inline', ...args]);
    await until(() => resumed.output().includes('fake/test'), 'resumed interactive mount');
    expect((await events()).at(-1)).toMatchObject({
      event: 'SessionStart',
      session_id: child.sessionId,
      reason: 'resume',
    });
    resumed.child.stdin!.write('/exit\r');
    expect((await resumed.exited)[0], resumed.errors()).toBe(0);
    expect((await events()).at(-1)).toMatchObject({
      event: 'SessionEnd',
      session_id: child.sessionId,
      reason: 'exit',
    });
  }
}, 15000);

it.each([
  'SIGTERM',
  'SIGHUP',
] as const)('flushes session.end to a mod helper when an idle interactive process receives %s', async (signal) => {
  await configure();
  const modelServer = spawn(
    process.execPath,
    [new URL('./fixtures/fake-model-server.mjs', import.meta.url).pathname],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  children.push(modelServer);
  const [ready] = await once(modelServer.stdout!, 'data');
  const port = String(ready).trim().split(' ')[1];
  const configPath = join(home, '.chimera/config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.providers.fake.baseUrl = `http://127.0.0.1:${port}/v1`;
  await writeFile(configPath, JSON.stringify(config));
  const mod = join(home, 'mod');
  const capture = join(home, 'mod-events.jsonl');
  await mkdir(mod);
  await writeFile(
    join(mod, 'chimera-mod.json'),
    JSON.stringify({
      name: 'capture',
      version: '1',
      apiVersion: 1,
      module: 'index.mjs',
    }),
  );
  const helper = `require('node:readline').createInterface({input:process.stdin}).on('line', line => require('node:fs').appendFileSync(${JSON.stringify(capture)}, line+'\\n'));`;
  await writeFile(
    join(mod, 'index.mjs'),
    `
export function register(on) {
  let child;
  for (const name of ['session.start', 'turn.complete', 'session.end']) {
    on(name, async ($, event) => {
      child ??= $.process.spawn({argv: [${JSON.stringify(process.execPath)}, '-e', ${JSON.stringify(helper)}]});
      await child.write(JSON.stringify(event) + '\\n');
    });
  }
}
`,
  );
  const interactive = launch(['--inline', '--mod-dir', mod]);
  await until(() => interactive.output().includes('fake/test'), 'interactive mount');
  interactive.child.stdin!.write('hello\r');
  const captured = async () => {
    try {
      return (await readFile(capture, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  await until(
    async () => (await captured()).some((event) => event.type === 'turn.complete'),
    'completed turn in helper',
  );
  interactive.child.kill(signal);
  expect((await interactive.exited)[0], interactive.errors()).toBe(0);
  expect((await captured()).at(-1)).toMatchObject({ type: 'session.end', reason: 'signal' });
}, 15000);
