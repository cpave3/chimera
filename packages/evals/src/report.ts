import { MODELS } from './models';
import type { CaseOutcome } from './run-case';
import { TASKS } from './tasks';
import { VARIANTS } from './variants';

interface ExportedResult {
  status: string;
  output: unknown;
}

interface ExportedEval {
  name: string;
  results: ExportedResult[];
}

function isOutcome(output: unknown): output is CaseOutcome {
  return typeof output === 'object' && output !== null && 'task' in output && 'metrics' in output;
}

/** The outcomes in an evalite JSON export, and the errors of the cases that threw. */
export function readExport(exported: unknown): { outcomes: CaseOutcome[]; errors: string[] } {
  const outcomes: CaseOutcome[] = [];
  const errors: string[] = [];
  for (const evaluation of (exported as { evals: ExportedEval[] }).evals) {
    for (const result of evaluation.results) {
      if (isOutcome(result.output)) {
        outcomes.push(result.output);
      } else {
        const message = (result.output as { message?: string } | null)?.message ?? 'no output';
        errors.push(`${evaluation.name}: ${message}`);
      }
    }
  }
  return { outcomes, errors };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '-' : `${Math.round((part / whole) * 100)}%`;
}

function renderTable(rows: string[][]): string {
  const widths = rows[0]!.map((_header, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

const cellName = (outcome: CaseOutcome) => `${outcome.model} · ${outcome.variant}`;

/** The place of an id in a table of known ids. An unknown id comes after them all. */
function rank(ids: string[], id: string): number {
  const index = ids.indexOf(id);
  return index === -1 ? ids.length : index;
}

const MODEL_IDS = MODELS.map((model) => model.id);
const VARIANT_IDS = VARIANTS.map((variant) => variant.id);
const TASK_IDS = TASKS.map((task) => task.id);

/** An export has no useful order: put the runs in the order of the model, variant and task tables. */
function inTableOrder(outcomes: CaseOutcome[]): CaseOutcome[] {
  return [...outcomes].sort(
    (a, b) =>
      rank(MODEL_IDS, a.model) - rank(MODEL_IDS, b.model) ||
      a.model.localeCompare(b.model) ||
      rank(VARIANT_IDS, a.variant) - rank(VARIANT_IDS, b.variant) ||
      rank(TASK_IDS, a.task) - rank(TASK_IDS, b.task),
  );
}

function summaryTable(cells: Map<string, CaseOutcome[]>): string {
  const rows = [
    [
      'model',
      'variant',
      'runs',
      'solved',
      'finished',
      'steps',
      'tool errors',
      'repeats',
      'seconds',
      'prompt',
    ],
  ];
  for (const runs of cells.values()) {
    const sum = (pick: (outcome: CaseOutcome) => number) =>
      runs.reduce((total, outcome) => total + pick(outcome), 0);
    rows.push([
      runs[0]!.model,
      runs[0]!.variant,
      String(runs.length),
      percent(runs.filter((outcome) => outcome.pass).length, runs.length),
      percent(runs.filter((outcome) => outcome.finished).length, runs.length),
      String(median(runs.map((outcome) => outcome.metrics.steps))),
      percent(
        sum((outcome) => outcome.metrics.toolErrors),
        sum((outcome) => outcome.metrics.toolCalls),
      ),
      String(sum((outcome) => outcome.metrics.repeatedCalls)),
      String(median(runs.map((outcome) => outcome.seconds))),
      String(median(runs.map((outcome) => outcome.metrics.promptFloorTokens))),
    ]);
  }
  return renderTable(rows);
}

function taskTable(outcomes: CaseOutcome[], cells: Map<string, CaseOutcome[]>): string {
  const rows = [['task', ...cells.keys()]];
  const tasks = [...new Set(outcomes.map((outcome) => outcome.task))].sort(
    (a, b) => rank(TASK_IDS, a) - rank(TASK_IDS, b),
  );
  for (const task of tasks) {
    rows.push([
      task,
      ...[...cells.values()].map((runs) => {
        const ofTask = runs.filter((outcome) => outcome.task === task);
        if (ofTask.length === 0) return '-';
        return `${ofTask.filter((outcome) => outcome.pass).length}/${ofTask.length}`;
      }),
    ]);
  }
  return renderTable(rows);
}

function problemList(outcomes: CaseOutcome[]): string {
  const problems = outcomes.filter((outcome) => !outcome.pass || !outcome.finished);
  if (problems.length === 0) return 'Every run was solved and finished.';
  return problems
    .map((outcome) => {
      const end = outcome.stopped ?? outcome.metrics.finishReason;
      const detail = outcome.pass ? 'solved, but did not finish' : outcome.detail.slice(0, 160);
      const summary = `${cellName(outcome)}  ${outcome.task}  ${end}  ${detail}`;
      return outcome.artifacts ? `${summary}\n    ${outcome.artifacts}` : summary;
    })
    .join('\n');
}

/**
 * A plain-text report: one line for each model and variant, the solved runs
 * of each task, and the runs to look at.
 */
export function renderReport(outcomes: CaseOutcome[]): string {
  if (outcomes.length === 0) return 'No runs.';
  const ordered = inTableOrder(outcomes);
  const cells = groupBy(ordered, cellName);
  return [
    summaryTable(cells),
    '',
    'steps, seconds and prompt are medians; prompt is the input tokens of the first step.',
    '',
    taskTable(ordered, cells),
    '',
    'Not solved or not finished:',
    problemList(ordered),
  ].join('\n');
}
