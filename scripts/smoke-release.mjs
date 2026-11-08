#!/usr/bin/env node
// Smoke test of a release binary: what only a single-file build can get
// wrong. Runs the binary with a scratch HOME against the fake model server.
//
// Usage: node scripts/smoke-release.mjs <binary> <version>
// Exits non-zero, naming the failed check, on any failure.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
const failures = [];

function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}\n`);
  if (!ok) failures.push(`${name}${detail ? `\n${detail}` : ''}`);
}

function chimera(args, options = {}) {
  return spawnSync(binary, args, {
    cwd: work,
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: home, TERM: 'dumb', ...options.env },
  });
}

// A project's .env must not reach the agent: bun's autoload is off.
writeFileSync(join(work, '.env'), 'CHIMERA_SMOKE_DOTENV=leaked\n');

const script = [
  {
    when: 'smoke test',
    tool: 'spawn_agent',
    args: { prompt: 'child task: answer at once', purpose: 'smoke child' },
  },
  { when: 'child task', text: 'child answered' },
  {
    when: 'child answered',
    tool: 'bash',
    args: { command: 'echo "dotenv=${CHIMERA_SMOKE_DOTENV:-unset}"' },
  },
  { when: 'dotenv=', text: 'Smoke run finished.' },
];
writeFileSync(join(scratch, 'script.json'), JSON.stringify(script));
const server = spawn(process.execPath, [fakeServer, join(scratch, 'script.json'), '0']);

try {
  const port = await new Promise((resolvePort, reject) => {
    server.on('error', reject);
    server.stdout.on('data', (chunk) => {
      const match = /listening (\d+)/.exec(String(chunk));
      if (match) resolvePort(Number(match[1]));
    });
  });
  writeFileSync(
    join(home, '.chimera', 'config.json'),
    JSON.stringify({
      providers: { fake: { shape: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x' } },
      defaultModel: 'fake/model',
      models: { 'fake/model': { contextWindow: 100_000 } },
      workspaceCheckpoints: false,
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

  const run = chimera(['run', 'smoke test']);
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
