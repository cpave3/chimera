#!/usr/bin/env node
// Scores a set of labelled bash commands with the questions of the System One
// check, and prints what each threshold would let through. Use it to choose
// `systemOne.threshold` for a model.
//
//   pnpm --filter @chimera/permissions build
//   node packages/permissions/scripts/system-one-calibrate.mjs \
//     --url http://localhost:8012/v1/systemone [--model jev-latest] \
//     [--key-env JEV_API_KEY] [--cases my-cases.json] [--list]
//
// The commands are sent to the server and never run. A cases file is
// {"safe": [command, ...], "unsafe": [command, ...]}.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildSystemOneRequest, systemOneSafety } from '../dist/index.js';

const { values: options } = parseArgs({
  options: {
    url: { type: 'string' },
    model: { type: 'string', default: 'jev-latest' },
    'key-env': { type: 'string' },
    cases: {
      type: 'string',
      default: new URL('./system-one-cases.json', import.meta.url).pathname,
    },
    cwd: { type: 'string', default: '/home/dev/projects/shop' },
    list: { type: 'boolean', default: false },
  },
});
if (!options.url) {
  console.error('usage: system-one-calibrate.mjs --url <.../v1/systemone> [--model <name>]');
  process.exit(2);
}
const apiKey = options['key-env'] ? process.env[options['key-env']] : undefined;
const cases = JSON.parse(readFileSync(options.cases, 'utf8'));

async function ask(command) {
  const request = {
    requestId: 'calibrate',
    tool: 'bash',
    target: 'host',
    command,
    cwd: options.cwd,
  };
  const response = await fetch(options.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(buildSystemOneRequest(request, options.model)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return systemOneSafety((await response.json()).answers);
}

// A hosted model now and then fails one request; one lost answer must not end a run.
async function safetyOf(command) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await ask(command);
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

async function rate(commands, label) {
  const rated = [];
  for (let start = 0; start < commands.length; start += 6) {
    const batch = commands.slice(start, start + 6);
    const safeties = await Promise.all(batch.map(safetyOf));
    for (const [index, command] of batch.entries()) {
      rated.push({ command, label, safety: safeties[index] });
    }
  }
  return rated;
}

const safe = await rate(cases.safe, 'safe');
const unsafe = await rate(cases.unsafe, 'unsafe');
const highestUnsafe = Math.max(...unsafe.map((item) => item.safety));

console.log(`model ${options.model} at ${options.url}`);
console.log(`${safe.length} safe commands, ${unsafe.length} unsafe commands\n`);
console.log('threshold  safe approved  unsafe approved');
for (const threshold of [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]) {
  const approvedSafe = safe.filter((item) => item.safety >= threshold).length;
  const approvedUnsafe = unsafe.filter((item) => item.safety >= threshold).length;
  console.log(
    `   ${threshold.toFixed(2)}     ${String(approvedSafe).padStart(3)}/${safe.length}        ${String(approvedUnsafe).padStart(3)}/${unsafe.length}`,
  );
}
console.log(
  `\nhighest safety of an unsafe command: ${highestUnsafe.toFixed(3)} ` +
    `(${safe.filter((item) => item.safety > highestUnsafe).length}/${safe.length} safe commands are above it)`,
);

const clip = (command) => (command.length > 90 ? `${command.slice(0, 87)}...` : command);
const bySafety = (left, right) => right.safety - left.safety;
if (options.list) {
  console.log('\nevery command, safest first:');
  for (const item of [...safe, ...unsafe].sort(bySafety)) {
    console.log(`  ${item.safety.toFixed(2)} ${item.label.padEnd(6)} ${clip(item.command)}`);
  }
} else {
  console.log('\nthe unsafe commands the model rates safest:');
  for (const item of [...unsafe].sort(bySafety).slice(0, 8)) {
    console.log(`  ${item.safety.toFixed(2)} ${clip(item.command)}`);
  }
}
