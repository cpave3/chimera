import { describe, expect, it } from 'vitest';
import { readSelection, SELECTION_ENV } from '../src/selection';
import { TASKS } from '../src/tasks';

describe('readSelection', () => {
  it('selects the default models, the profile of today, every task and three trials', () => {
    const selection = readSelection({});

    expect(selection.models.map((model) => model.id)).toEqual([
      'qwen3.5-9b',
      'gemma-4-12b',
      'qwen3.8-27b',
    ]);
    expect(selection.variants.map((variant) => variant.id)).toEqual(['guided']);
    expect(selection.tasks).toEqual(TASKS);
    expect(selection.trials).toBe(3);
    expect(selection.manageModels).toBe(true);
    expect(selection.settings).toMatchObject({
      baseUrl: 'http://127.0.0.1:1234/v1',
      contextWindow: 32_768,
      maxSteps: 30,
      timeoutMs: 300_000,
    });
    expect(selection.settings.command.at(-1)).toMatch(/packages\/cli\/dist\/bin\.js$/);
  });

  it('takes what the CLI chose from the environment', () => {
    const selection = readSelection({
      [SELECTION_ENV]: JSON.stringify({
        models: ['gemma-4-26b', 'some/other-model'],
        variants: ['lean', 'patch'],
        tasks: ['verify'],
        trials: 5,
        timeoutSeconds: 60,
        chimeraCommand: ['chimera'],
        manageModels: false,
      }),
    });

    expect(selection.models).toEqual([
      { id: 'gemma-4-26b', key: 'google/gemma-4-26b-a4b' },
      { id: 'some-other-model', key: 'some/other-model' },
    ]);
    expect(selection.variants.map((variant) => variant.id)).toEqual(['lean', 'patch']);
    expect(selection.tasks.map((task) => task.id)).toEqual(['fix-failing-test', 'fix-two-bugs']);
    expect(selection.trials).toBe(5);
    expect(selection.manageModels).toBe(false);
    expect(selection.settings.timeoutMs).toBe(60_000);
    expect(selection.settings.command).toEqual(['chimera']);
  });
});
