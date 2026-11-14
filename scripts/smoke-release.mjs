#!/usr/bin/env node
// Smoke test of a release binary: what only a single-file build can get
// wrong. Runs the binary with a scratch HOME against the fake model server.
// External mods deliberately live outside the bundle and import no Chimera runtime.
//
// Usage: node scripts/smoke-release.mjs <binary> <version>
// Exits non-zero, naming the failed check, on any failure.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';

const [binaryArgument, version] = process.argv.slice(2);
if (!binaryArgument || !version) {
  process.stderr.write('usage: node scripts/smoke-release.mjs <binary> <version>\n');
  process.exit(2);
}
const binary = resolve(binaryArgument);
const root = resolve(import.meta.dirname, '..');
const fakeServer = join(root, 'packages/cli/test/fixtures/fake-model-server.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'chimera-smoke-'));
const home = join(scratch, 'home');
const work = join(scratch, 'work');
mkdirSync(join(home, '.chimera'), { recursive: true });
mkdirSync(work);
const childWork = join(scratch, 'child', 'work');
mkdirSync(childWork, { recursive: true });
const failures = [];
// Deliberately fixed test-only credential; never forward the caller's environment.
const smokeSecret = 'release-smoke-only-secret';

function safeDetail(detail) {
  return String(detail).replaceAll(smokeSecret, '[redacted]');
}

function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}\n`);
  if (!ok) failures.push(`${name}${detail ? `\n${safeDetail(detail)}` : ''}`);
}

function environment(extra = {}) {
  return { PATH: process.env.PATH, HOME: home, TERM: 'dumb', ...extra };
}

function chimera(args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: work,
    encoding: 'utf8',
    timeout: 120_000,
    env: environment(options.env),
  });
  return {
    ...result,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`,
  };
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

// A project's .env must not reach the agent: bun's autoload is off.
writeFileSync(join(work, '.env'), 'CHIMERA_SMOKE_DOTENV=leaked\n');

const script = [
  {
    when: 'smoke test',
    tool: 'spawn_agent',
    args: { prompt: 'child task: answer at once', purpose: 'smoke child', cwd: childWork },
  },
  { when: 'child task', text: 'child answered' },
  {
    when: 'child answered',
    tool: 'bash',
    args: { command: 'echo "dotenv=${CHIMERA_SMOKE_DOTENV:-unset}"' },
  },
  { when: 'dotenv=', text: 'Smoke run finished.' },
];
writeFileSync(
  join(scratch, 'script.json'),
  JSON.stringify(script.map((step) => ({ ...step, repeat: true }))),
);
const server = spawn(process.execPath, [fakeServer, join(scratch, 'script.json'), '0']);

try {
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error('fake server startup timed out')), 10_000);
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('fake server exited before startup'));
    });
    server.on('error', reject);
    server.stdout.on('data', (chunk) => {
      const match = /listening (\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
  });
  writeFileSync(
    join(home, '.chimera', 'config.json'),
    JSON.stringify({
      providers: { fake: { shape: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x' } },
      defaultModel: 'fake/model',
      models: { 'fake/model': { contextWindow: 100_000 } },
      workspaceCheckpoints: false,
      updates: { mode: 'off' },
    }),
  );

  const shown = chimera(['--version']);
  check(
    '--version reports the version',
    shown.stdout.trim() === version,
    shown.stdout + shown.stderr,
  );
  const report = chimera(['version', '--json']);
  let parsed = null;
  try {
    parsed = JSON.parse(report.stdout);
  } catch {}
  check(
    'version --json reports the version',
    parsed?.version === version && parsed?.release === /^v\d+\.\d+\.\d+$/.test(version),
    report.stdout + report.stderr,
  );
  check('version --json advertises mod API 1', JSON.stringify(parsed?.modApi) === '[1]');

  const types = chimera(['mod', 'types']);
  check(
    'mod types emits bundled authoring declarations',
    types.status === 0 &&
      /export type Register\s*=/.test(types.stdout) &&
      types.stdout.includes('interface ModContext'),
    types.stderr,
  );
  const modDirectories = [];
  const fixture = readFileSync(join(root, 'scripts/fixtures/release-mod.mts'), 'utf8');
  for (const extension of ['mjs', 'mts']) {
    const directory = join(scratch, `external-${extension}`);
    mkdirSync(directory);
    modDirectories.push(directory);
    writeFileSync(
      join(directory, 'chimera-mod.json'),
      JSON.stringify({
        name: `release-${extension}`,
        version: '1.0.0',
        apiVersion: 1,
        module: `index.${extension}`,
      }),
    );
    // This import must be erased by the release runtime, not resolved as a runtime package.
    const source =
      extension === 'mjs'
        ? fixture
            .replace("import type { Register } from './chimera-mod-api.d.ts';\n", '')
            .replace(': Register', '')
            .replace(' as const', '')
        : fixture;
    writeFileSync(join(directory, `index.${extension}`), source);
    writeFileSync(join(directory, 'chimera-mod-api.d.ts'), types.stdout);
  }
  const modEnvironment = {
    CHIMERA_MOD_DIRS: modDirectories.join(delimiter),
    CHIMERA_SERVER_SECRET: smokeSecret,
    CHIMERA_SMOKE_RESULTS: scratch,
    CHIMERA_SMOKE_NODE: process.execPath,
  };
  const listed = chimera(['mod', 'list', '--json'], { env: modEnvironment });
  let listedMods = [];
  try {
    listedMods = JSON.parse(listed.stdout);
  } catch {}
  check(
    'external mjs and mts mods load via CHIMERA_MOD_DIRS',
    listed.status === 0 &&
      ['release-mjs', 'release-mts'].every((name) =>
        listedMods.some((record) => record.name === name && record.status === 'loaded'),
      ),
    listed.stdout + listed.stderr,
  );
  for (const directory of modDirectories) {
    const validated = chimera(['mod', 'validate', directory, '--json']);
    check(
      `mod validate accepts ${directory.split('/').at(-1)}`,
      validated.status === 0,
      validated.stderr,
    );
  }
  const harnessMod = join(scratch, 'harness-mod');
  mkdirSync(join(harnessMod, 'tests'), { recursive: true });
  writeFileSync(
    join(harnessMod, 'chimera-mod.json'),
    JSON.stringify({
      name: 'harness-smoke',
      version: '1',
      apiVersion: 1,
      module: 'index.mjs',
    }),
  );
  writeFileSync(
    join(harnessMod, 'index.mjs'),
    `
export function register(on) {
  on('session.start', async ($) => { await $.ui.log('started', {to: 'debug'}); });
  on('tool.call', () => ({decision: 'block', reason: 'smoke policy'}));
}
`,
  );
  const harnessTest = join(harnessMod, 'tests', 'smoke.test.mjs');
  writeFileSync(
    harnessTest,
    `
import assert from 'node:assert/strict';
export async function test(harness) {
  await harness.emit({type: 'session.start', sessionId: 'fixture', reason: 'new'});
  assert.equal(harness.calls[0].path, 'ui.log');
  assert.equal((await harness.emit({type: 'tool.call', toolName: 'bash', args: {}})).reason, 'smoke policy');
}
`,
  );
  const harnessPass = chimera(['mod', 'test', harnessMod]);
  check('mod test drives observers and interceptors', harnessPass.status === 0, harnessPass.stderr);
  writeFileSync(
    harnessTest,
    "export function test() { throw new Error('expected smoke failure'); }",
  );
  const harnessFailure = chimera(['mod', 'test', harnessMod]);
  check(
    'mod test reports assertion failures',
    harnessFailure.status !== 0 && harnessFailure.stderr.includes('expected smoke failure'),
    harnessFailure.stderr,
  );

  const modRun = chimera(['run', 'release mod smoke'], { env: modEnvironment });
  check('external mod run exits 0', modRun.status === 0, modRun.stdout + modRun.stderr);
  check(
    'mod run output does not expose the server secret',
    !`${modRun.stdout}${modRun.stderr}`.includes(smokeSecret),
  );
  for (const extension of ['mjs', 'mts']) {
    const name = `release-${extension}`;
    const resultPath = join(scratch, `${name}.jsonl`);
    let records = [];
    try {
      records = readFileSync(resultPath, 'utf8').trim().split('\n').map(JSON.parse);
    } catch {}
    check(
      `${extension} mod receives ordered lifecycle and runtime versions`,
      JSON.stringify(records.slice(1).map((record) => record.type)) ===
        JSON.stringify(['session.start', 'turn.start', 'turn.complete', 'session.end']) &&
        records.slice(1).every((record) => record.version === version && record.apiVersion === 1),
    );
    for (const capability of [
      'authenticated',
      'anonymousDenied',
      'secretRemoved',
      'helperClean',
      'helperExited',
      'storeRoundTrip',
    ]) {
      check(`${extension} mod ${capability}`, records[0]?.[capability] === true);
    }
    check(
      `${extension} mod store persists under scratch HOME`,
      readJson(join(home, '.chimera', 'mod-data', name, 'release-smoke.json')) === 'stored',
    );
  }

  // run has no discovery lock; serve must create one without its authenticated URL.
  const serving = spawn(binary, ['serve', '--port', '0', '--machine-handshake'], {
    cwd: work,
    env: environment({ CHIMERA_SERVER_SECRET: smokeSecret }),
    stdio: 'ignore',
  });
  let serveError = false;
  serving.on('error', () => {
    serveError = true;
  });
  const serveExit = new Promise((resolveExit) => {
    serving.once('error', resolveExit);
    serving.once('exit', resolveExit);
  });
  try {
    const instances = join(home, '.chimera', 'instances');
    const deadline = Date.now() + 15_000;
    let locks = [];
    while (Date.now() < deadline && !serveError && serving.exitCode === null) {
      locks = existsSync(instances)
        ? readdirSync(instances).filter((name) => name.endsWith('.json'))
        : [];
      if (locks.length) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    check(
      'serve writes a discovery lock without secrets',
      locks.length > 0 &&
        locks.every((name) => {
          const text = readFileSync(join(instances, name), 'utf8');
          const lock = JSON.parse(text);
          return (
            !text.includes(smokeSecret) &&
            lock.pid === serving.pid &&
            lock.url === new URL(lock.url).origin
          );
        }),
    );
  } finally {
    serving.kill('SIGTERM');
    const killTimer = setTimeout(() => serving.kill('SIGKILL'), 5_000);
    await serveExit;
    clearTimeout(killTimer);
  }
  const help = chimera(['--help']);
  check('--help works', help.status === 0 && help.stdout.includes('Usage'), help.stderr);

  const skills = chimera(['skills']);
  check(
    'the built-in skill loads',
    skills.stdout.includes('review-bash-policy'),
    skills.stdout + skills.stderr,
  );
  const agents = chimera(['agents']);
  check(
    'the built-in agent loads',
    agents.stdout.includes('explore'),
    agents.stdout + agents.stderr,
  );

  // An unknown mode only warns and falls back, so the warning is the check.
  const planned = chimera(['run', '--mode', 'plan', 'hello']);
  check(
    'the built-in plan mode loads',
    !/mode "\w+" not found/.test(planned.stderr),
    planned.stderr,
  );

  const run = chimera(['run', '--mod-dir', relative(work, modDirectories[0]), 'smoke test'], {
    env: {
      CHIMERA_SMOKE_RESULTS: scratch,
      CHIMERA_SMOKE_NODE: process.execPath,
      CHIMERA_SERVER_SECRET: smokeSecret,
    },
  });
  const output = `${run.stdout}\n${run.stderr}`;
  check('chimera run exits 0', run.status === 0, output);
  check('the built-in build mode loads', !/mode "\w+" not found/.test(run.stderr), run.stderr);
  check(
    'a spawn_agent child starts and answers',
    /agent {2}smoke child {2}done/.test(run.stderr),
    output,
  );
  check(
    'a bash command passes the tree-sitter policy and runs',
    /bash {2}echo .*\n\s+dotenv=/.test(run.stderr),
    output,
  );
  check('.env stays out of the agent', run.stderr.includes('dotenv=unset'), output);
  check('the run finishes', run.stdout.includes('Smoke run finished.'), output);
  const starts = readFileSync(join(scratch, 'release-mjs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === 'session.start');
  check(
    'flag-loaded mod reaches subagents with parent metadata',
    starts.some(
      (child) =>
        child.isSubagent &&
        starts.some((parent) => parent.sessionId === child.parentId && !parent.isSubagent),
    ),
  );
  const envRun = chimera(['run', 'smoke test'], {
    env: { ...modEnvironment, CHIMERA_MOD_DIRS: relative(work, modDirectories[0]) },
  });
  const envStarts = readFileSync(join(scratch, 'release-mjs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === 'session.start')
    .slice(starts.length);
  check(
    'relative environment mod reaches a child with a different cwd',
    envRun.status === 0 && envStarts.some((event) => event.isSubagent),
    envRun.stderr,
  );
} finally {
  server.kill();
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(
    `\nsmoke test failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write('smoke test passed\n');
