import { parseArgs } from 'node:util';
import type { SelectionInput } from './selection';
import { VARIANTS } from './variants';

export type CliCommand =
  | { command: 'run'; input: SelectionInput; keepLoaded: boolean }
  | { command: 'list' }
  | { command: 'report'; file: string | undefined }
  | { command: 'ui'; port: number }
  | { command: 'help' };

export const HELP = `chimera-evals: measure chimera with local models

Commands
  run             Run the evals, then print a report
  list            Show the models, the variants and the tasks
  report [file]   Print the report of the last run, or of an exported file
  ui              Browse the stored runs in the evalite web UI

Options of run
  --models <a,b>       Model ids, or model keys of the server (default: qwen3.5-9b,gemma-4-12b,qwen3.8-27b)
  --variants <a,b>     Profile variants, or "all" (default: guided)
  --tasks <a,b>        Task ids, categories, or id prefixes that end in * (default: every task)
  --trials <n>         Runs of each task (default: 3)
  --context <tokens>   Context length the model is loaded with (default: 32768)
  --max-steps <n>      Step limit of one run (default: 30)
  --timeout <seconds>  Time limit of one run (default: 300)
  --base-url <url>     OpenAI-compatible endpoint (default: http://127.0.0.1:1234/v1)
  --chimera <path>     The chimera binary to test (default: packages/cli/dist/bin.js of this checkout)
  --no-load            Do not load or unload models; use the model the server has loaded
  --keep-loaded        Leave the last model loaded when the run ends

Options of ui
  --port <n>           Port of the web UI (default: 3006)
`;

function list(value: string | undefined): string[] | undefined {
  return value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInteger(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${flag} must be a whole number above 0`);
  }
  return parsed;
}

/** Drops the keys with no value, so that a default applies to them later. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function parseCli(argv: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      models: { type: 'string' },
      variants: { type: 'string' },
      tasks: { type: 'string' },
      trials: { type: 'string' },
      context: { type: 'string' },
      'max-steps': { type: 'string' },
      timeout: { type: 'string' },
      'base-url': { type: 'string' },
      chimera: { type: 'string' },
      'no-load': { type: 'boolean' },
      'keep-loaded': { type: 'boolean' },
      port: { type: 'string' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === 'help') return { command: 'help' };

  switch (command) {
    case 'run': {
      const variants = list(values.variants);
      return {
        command: 'run',
        keepLoaded: values['keep-loaded'] === true,
        input: defined<SelectionInput>({
          models: list(values.models),
          variants: variants?.includes('all') ? VARIANTS.map((variant) => variant.id) : variants,
          tasks: list(values.tasks),
          trials: positiveInteger('trials', values.trials),
          contextWindow: positiveInteger('context', values.context),
          maxSteps: positiveInteger('max-steps', values['max-steps']),
          timeoutSeconds: positiveInteger('timeout', values.timeout),
          baseUrl: values['base-url'],
          chimeraCommand: values.chimera ? [values.chimera] : undefined,
          manageModels: values['no-load'] ? false : undefined,
        }),
      };
    }
    case 'list':
      return { command: 'list' };
    case 'report':
      return { command: 'report', file: rest[0] };
    case 'ui':
      return { command: 'ui', port: positiveInteger('port', values.port) ?? 3006 };
    default:
      throw new Error(`Unknown command "${command}". Run chimera-evals --help.`);
  }
}
