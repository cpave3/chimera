#!/usr/bin/env node
// Turns the System One log into data for tuning a model. It joins
// ~/.chimera/logs/system-one-decisions.jsonl with the decision audit and
// writes two files to ~/.chimera/system-one-export/:
//
//   labelled.jsonl  one row for each time the model rated a command that a
//                   person labelled: at the approval prompt, or in review.jsonl
//   review.jsonl    one row for each distinct command that nobody decided
//
// To label more commands, set "label" in review.jsonl to "safe" or "unsafe"
// and run the script again. It keeps the labels you filled in.
//
//   pnpm --filter @chimera/permissions build
//   node packages/permissions/scripts/system-one-export.mjs [--home <dir>] [--out <dir>]
//
// Likely credentials are taken out of the commands. Read the files before
// you give them to anybody: the redaction knows only common patterns.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { exportSystemOneLog, permissionAuditPath, systemOneAuditPath } from '../dist/index.js';

const { values: options } = parseArgs({
  options: { home: { type: 'string', default: homedir() }, out: { type: 'string' } },
});
const outDirectory = options.out ?? join(options.home, '.chimera', 'system-one-export');
const labelledPath = join(outDirectory, 'labelled.jsonl');
const reviewPath = join(outDirectory, 'review.jsonl');

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1} is not JSON: ${error.message}`);
      }
    });
}

function writeJsonLines(path, rows) {
  writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
  chmodSync(path, 0o600);
}

const checksPath = systemOneAuditPath(options.home);
const checks = readJsonLines(checksPath);
if (checks.length === 0) {
  console.error(`no System One records in ${checksPath}`);
  process.exit(1);
}

let exported;
try {
  exported = exportSystemOneLog({
    checks,
    decisions: readJsonLines(permissionAuditPath(options.home)),
    reviewed: readJsonLines(reviewPath),
  });
} catch (error) {
  console.error(`${reviewPath}: ${error.message}`);
  process.exit(1);
}
const { labelled, review } = exported;

mkdirSync(outDirectory, { recursive: true, mode: 0o700 });
writeJsonLines(labelledPath, labelled);
writeJsonLines(reviewPath, review);

const count = (rows, test) => rows.filter(test).length;
const versions = [...new Set(checks.map((record) => record.promptVersion ?? 'none'))];
console.log(`${checks.length} commands rated by the model`);
console.log(
  `  outcomes: ${count(checks, (r) => r.outcome === 'approved')} approved, ` +
    `${count(checks, (r) => r.outcome === 'rejected')} rejected, ` +
    `${count(checks, (r) => r.outcome === 'failed')} failed`,
);
console.log(`  prompt versions: ${versions.join(', ')}`);
console.log(`\n${labelled.length} labelled rows -> ${labelledPath}`);
for (const source of ['user', 'review']) {
  const ofSource = labelled.filter((row) => row.labelSource === source);
  console.log(
    `  by ${source.padEnd(6)} ${count(ofSource, (row) => row.label === 'safe')} safe, ` +
      `${count(ofSource, (row) => row.label === 'unsafe')} unsafe`,
  );
}
console.log(`\n${review.length} distinct commands in ${reviewPath}`);
console.log(`  ${count(review, (row) => row.label === null)} have no label yet`);
