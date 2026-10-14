import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL_IDS, type EvalModel, findModel } from './models';
import type { RunSettings } from './run-case';
import { type EvalTask, findTasks } from './tasks';
import { findVariant, type Variant } from './variants';

/** The CLI passes its choices to the eval file in this environment variable, as JSON. */
export const SELECTION_ENV = 'CHIMERA_EVALS_SELECTION';

/** `src/` and `dist/` are both one level below the package directory. */
export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
/** The evalite database, the exports and the kept runs. `CHIMERA_EVALS_RESULTS_DIR` moves it. */
export const RESULTS_DIR = process.env.CHIMERA_EVALS_RESULTS_DIR ?? join(PACKAGE_DIR, '.results');

export interface SelectionInput {
  models?: string[];
  variants?: string[];
  /** Task ids, categories, or id prefixes that end in `*`. */
  tasks?: string[];
  trials?: number;
  contextWindow?: number;
  maxSteps?: number;
  timeoutSeconds?: number;
  baseUrl?: string;
  chimeraCommand?: string[];
  artifactsDir?: string;
  /** False leaves loading and unloading of models to the user. */
  manageModels?: boolean;
}

export interface Selection {
  models: EvalModel[];
  variants: Variant[];
  tasks: EvalTask[];
  trials: number;
  manageModels: boolean;
  settings: RunSettings;
}

export function resolveSelection(input: SelectionInput): Selection {
  return {
    models: (input.models ?? DEFAULT_MODEL_IDS).map(findModel),
    variants: (input.variants ?? ['guided']).map(findVariant),
    tasks: findTasks(input.tasks ?? []),
    trials: input.trials ?? 3,
    manageModels: input.manageModels ?? true,
    settings: {
      command: input.chimeraCommand ?? [
        process.execPath,
        join(PACKAGE_DIR, '..', 'cli', 'dist', 'bin.js'),
      ],
      baseUrl: input.baseUrl ?? 'http://127.0.0.1:1234/v1',
      contextWindow: input.contextWindow ?? 32_768,
      maxSteps: input.maxSteps ?? 30,
      timeoutMs: (input.timeoutSeconds ?? 300) * 1000,
      artifactsDir: input.artifactsDir ?? join(RESULTS_DIR, 'runs'),
    },
  };
}

export function readSelection(env: NodeJS.ProcessEnv): Selection {
  const encoded = env[SELECTION_ENV];
  return resolveSelection(encoded ? (JSON.parse(encoded) as SelectionInput) : {});
}
