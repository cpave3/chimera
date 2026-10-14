import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'evalite/config';
import { createSqliteStorage } from 'evalite/sqlite-storage';
import { RESULTS_DIR } from './src/selection';

export default defineConfig({
  // Outside node_modules, so a reinstall keeps the history of earlier runs.
  storage: () => {
    mkdirSync(RESULTS_DIR, { recursive: true });
    return createSqliteStorage(join(RESULTS_DIR, 'evalite.db'));
  },
  // One model fits on the GPU at a time, and runs that share it slow each other.
  // The CLI prints its own report. evalite 0.19 ignores `--hideTable` on `run`.
  hideTable: true,
  maxConcurrency: 1,
  // Above the time limit of one run plus the load of the largest model.
  testTimeout: 30 * 60_000,
});
