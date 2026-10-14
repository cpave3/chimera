import { evalite } from 'evalite';
import { createModelLoader } from '../src/lmstudio';
import type { EvalModel } from '../src/models';
import { type CaseOutcome, runCase } from '../src/run-case';
import { readSelection } from '../src/selection';
import type { Variant } from '../src/variants';

const selection = readSelection(process.env);
const loader = createModelLoader();
const tasksById = new Map(selection.tasks.map((task) => [task.id, task]));

// Models are the outer loop: each one is loaded once, for all its variants.
const cells = selection.models.flatMap((model) =>
  selection.variants.map((variant) => ({
    name: `${model.id} · ${variant.id}`,
    input: { model, variant },
  })),
);

evalite.each<{ model: EvalModel; variant: Variant }>(cells)<string, CaseOutcome>('chimera', {
  data: selection.tasks.map((task) => ({ input: task.id })),
  task: async (taskId, cell) => {
    if (selection.manageModels) {
      await loader.ensureLoaded(cell.model.key, selection.settings.contextWindow);
    }
    return runCase({
      task: tasksById.get(taskId)!,
      model: cell.model,
      variant: cell.variant,
      settings: selection.settings,
    });
  },
  scorers: [
    {
      name: 'Solved',
      description: "The task's check accepts the workspace and the final message.",
      scorer: ({ output }) => ({ score: output.pass ? 1 : 0, metadata: { detail: output.detail } }),
    },
    {
      name: 'Finished',
      description: 'The run ended by itself, not at the step limit, the time limit or an error.',
      scorer: ({ output }) => ({
        score: output.finished ? 1 : 0,
        metadata: { finishReason: output.metrics.finishReason, stopped: output.stopped },
      }),
    },
  ],
  columns: ({ input, output }) => [
    { label: 'Task', value: input },
    { label: 'Result', value: `${output.pass ? 'solved' : 'not solved'}: ${output.detail}` },
    { label: 'End', value: output.stopped ?? output.metrics.finishReason },
    { label: 'Steps', value: output.metrics.steps },
    { label: 'Tool calls', value: output.metrics.toolCalls },
    { label: 'Tool errors', value: output.metrics.toolErrors },
    { label: 'Seconds', value: output.seconds },
    { label: 'Artifacts', value: output.artifacts ?? '' },
  ],
  trialCount: selection.trials,
});
