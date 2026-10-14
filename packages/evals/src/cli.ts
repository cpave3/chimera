import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'evalite/server';
import { createSqliteStorage } from 'evalite/sqlite-storage';
import { type CliCommand, HELP, parseCli } from './cli-args';
import { MODELS } from './models';
import { preflight } from './preflight';
import { readExport, renderReport } from './report';
import {
  PACKAGE_DIR,
  RESULTS_DIR,
  resolveSelection,
  SELECTION_ENV,
  type SelectionInput,
} from './selection';
import { TASKS } from './tasks';
import { VARIANTS } from './variants';

const LATEST_EXPORT = join(RESULTS_DIR, 'latest.json');

function printList(): void {
  const lines = ['Models (any other name is taken as a model key of the server)'];
  for (const model of MODELS) lines.push(`  ${model.id.padEnd(14)} ${model.key}`);
  lines.push('', 'Variants');
  for (const variant of VARIANTS) lines.push(`  ${variant.id.padEnd(14)} ${variant.description}`);
  lines.push('', 'Tasks');
  for (const task of TASKS) {
    lines.push(`  ${task.id.padEnd(18)} ${task.category.padEnd(9)} ${task.probes}`);
  }
  console.log(lines.join('\n'));
}

function printReport(file: string): void {
  const { outcomes, errors } = readExport(JSON.parse(readFileSync(file, 'utf8')));
  console.log(renderReport(outcomes));
  if (errors.length > 0) {
    console.log(`\nRuns that the harness could not do:\n${errors.join('\n')}`);
  }
}

function runEvalite(input: SelectionInput, exportPath: string): Promise<number | null> {
  const evaliteBin = join(dirname(createRequire(import.meta.url).resolve('evalite')), 'bin.js');
  const child = spawn(
    process.execPath,
    [evaliteBin, 'run', 'evals/chimera.eval.ts', '--outputPath', exportPath],
    {
      cwd: PACKAGE_DIR,
      stdio: 'inherit',
      env: { ...process.env, [SELECTION_ENV]: JSON.stringify(input) },
    },
  );
  return new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', resolveExit);
  });
}

async function run(command: Extract<CliCommand, { command: 'run' }>): Promise<number> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const input: SelectionInput = {
    artifactsDir: join(RESULTS_DIR, 'runs', stamp),
    ...command.input,
  };
  const selection = resolveSelection(input);

  const problems = await preflight(selection);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    return 1;
  }

  const cells = selection.models.length * selection.variants.length;
  const runs = cells * selection.tasks.length * selection.trials;
  console.log(
    `${selection.models.length} models x ${selection.variants.length} variants x ${selection.tasks.length} tasks x ${selection.trials} trials = ${runs} runs`,
  );

  mkdirSync(RESULTS_DIR, { recursive: true });
  const exportPath = join(RESULTS_DIR, `run-${stamp}.json`);
  // Ctrl+C goes to evalite too. Stay alive to free the GPU after it stops.
  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
  });
  try {
    await runEvalite(input, exportPath);
  } finally {
    if (selection.manageModels && !command.keepLoaded) {
      await promisify(execFile)('lms', ['unload', '--all']).catch(() => {});
    }
  }
  if (interrupted || !existsSync(exportPath)) {
    console.error('The run did not finish, so there is no report.');
    return 130;
  }

  copyFileSync(exportPath, LATEST_EXPORT);
  console.log('');
  printReport(exportPath);
  console.log(`\nExport: ${exportPath}\nBrowse every run: pnpm --filter @chimera/evals evals ui`);
  return 0;
}

async function serveUi(port: number): Promise<void> {
  const storage = await createSqliteStorage(join(RESULTS_DIR, 'evalite.db'));
  createServer({ storage }).start(port);
  console.log(`The stored runs are at http://localhost:${port} (Ctrl+C stops the server)`);
}

async function main(): Promise<number> {
  const command = parseCli(process.argv.slice(2));
  switch (command.command) {
    case 'help':
      console.log(HELP);
      return 0;
    case 'list':
      printList();
      return 0;
    case 'report': {
      const file = command.file ? resolve(command.file) : LATEST_EXPORT;
      if (!existsSync(file)) {
        console.error(`There is no export at ${file}. Run the evals first.`);
        return 1;
      }
      printReport(file);
      return 0;
    }
    case 'ui':
      await serveUi(command.port);
      return new Promise(() => {});
    case 'run':
      return run(command);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
