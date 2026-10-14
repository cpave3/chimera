import { describe, expect, it } from 'vitest';
import { readExport, renderReport } from '../src/report';
import type { CaseOutcome } from '../src/run-case';

function outcome(
  overrides: Omit<Partial<CaseOutcome>, 'metrics'> & { metrics?: Partial<CaseOutcome['metrics']> },
) {
  const { metrics, ...rest } = overrides;
  return {
    task: 'edit-single-line',
    category: 'edit',
    model: 'qwen3.5-9b',
    variant: 'guided',
    pass: true,
    detail: 'The tests pass.',
    finished: true,
    exitCode: 0,
    seconds: 10,
    metrics: {
      finishReason: 'stop',
      steps: 4,
      toolCalls: 3,
      toolCallsByName: {},
      toolErrors: 0,
      repeatedCalls: 0,
      textToolCalls: 0,
      subagents: 0,
      compactions: 0,
      inputTokens: 20_000,
      outputTokens: 200,
      promptFloorTokens: 5_700,
      peakContextTokens: 6_000,
      finalText: 'Done.',
      ...metrics,
    },
    ...rest,
  } as CaseOutcome;
}

function line(report: string, start: string): string {
  const found = report.split('\n').find((candidate) => candidate.startsWith(start));
  if (!found) throw new Error(`No line starts with "${start}" in:\n${report}`);
  return found.replace(/\s+/g, ' ').trim();
}

describe('renderReport', () => {
  const outcomes = [
    outcome({ seconds: 10, metrics: { steps: 4, toolCalls: 3 } }),
    outcome({ seconds: 30, metrics: { steps: 8, toolCalls: 6, toolErrors: 3, repeatedCalls: 2 } }),
    outcome({
      task: 'edit-tabs',
      pass: false,
      finished: false,
      detail: 'The tests fail: expected 55',
      seconds: 80,
      artifacts: '/results/runs/qwen3.5-9b/guided/edit-tabs-abc',
      metrics: { finishReason: 'max_steps', steps: 30, toolCalls: 11, toolErrors: 1 },
    }),
    outcome({ model: 'gemma-4-12b', seconds: 12 }),
  ];

  it('gives each model and variant one line with its rates and medians', () => {
    const report = renderReport(outcomes);

    expect(line(report, 'model')).toBe(
      'model variant runs solved finished steps tool errors repeats seconds prompt',
    );
    expect(line(report, 'qwen3.5-9b')).toBe('qwen3.5-9b guided 3 67% 67% 8 20% 2 30 5700');
    expect(line(report, 'gemma-4-12b')).toBe('gemma-4-12b guided 1 100% 100% 4 0% 0 12 5700');
  });

  it('shows how many runs of each task every model and variant solved', () => {
    const report = renderReport(outcomes);

    expect(line(report, 'task')).toBe('task qwen3.5-9b · guided gemma-4-12b · guided');
    expect(line(report, 'edit-single-line')).toBe('edit-single-line 2/2 1/1');
    expect(line(report, 'edit-tabs')).toBe('edit-tabs 0/1 -');
  });

  it('orders the models, the variants and the tasks as their tables do, whatever the order of the runs', () => {
    const shuffled = [
      outcome({ model: 'gemma-4-12b', variant: 'lean', task: 'add-feature' }),
      outcome({ model: 'some-other-model' }),
      outcome({ model: 'gemma-4-12b', variant: 'guided' }),
      outcome({ model: 'qwen3.5-9b', variant: 'lean' }),
      outcome({ model: 'qwen3.5-9b', variant: 'guided', task: 'edit-tabs' }),
    ];

    const report = renderReport(shuffled);

    expect(line(report, 'task')).toBe(
      'task qwen3.5-9b · guided qwen3.5-9b · lean gemma-4-12b · guided gemma-4-12b · lean some-other-model · guided',
    );
    const taskRows = report.split('\n').filter((row) => /^(edit|add)-/.test(row));
    expect(taskRows.map((row) => row.split(' ')[0])).toEqual([
      'edit-single-line',
      'edit-tabs',
      'add-feature',
    ]);
  });

  it('lists the runs that were not solved or did not finish, with where to look', () => {
    const report = renderReport(outcomes);

    expect(report).toContain(
      'qwen3.5-9b · guided  edit-tabs  max_steps  The tests fail: expected 55\n    /results/runs/qwen3.5-9b/guided/edit-tabs-abc',
    );
  });
});

describe('readExport', () => {
  it('takes the outcomes from an evalite export and keeps the errors of runs that threw', () => {
    const exported = {
      evals: [
        {
          name: 'chimera [qwen3.5-9b · guided]',
          results: [
            { status: 'success', output: outcome({}) },
            { status: 'fail', output: { name: 'Error', message: 'lms: model not found' } },
          ],
        },
      ],
    };

    const { outcomes, errors } = readExport(exported);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.task).toBe('edit-single-line');
    expect(errors).toEqual(['chimera [qwen3.5-9b · guided]: lms: model not found']);
  });
});
