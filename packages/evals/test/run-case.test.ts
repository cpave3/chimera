import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findModel } from '../src/models';
import { type RunSettings, runCase } from '../src/run-case';
import { findTasks } from '../src/tasks';
import { findVariant } from '../src/variants';

const FAKE_CHIMERA = [
  process.execPath,
  fileURLToPath(new URL('./fixtures/fake-chimera.mjs', import.meta.url)),
];

describe('runCase', () => {
  let artifactsDir: string;
  let settings: RunSettings;

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'chimera-evals-artifacts-'));
    settings = {
      command: FAKE_CHIMERA,
      baseUrl: 'http://127.0.0.1:1234/v1',
      contextWindow: 32_768,
      maxSteps: 30,
      timeoutMs: 10_000,
      artifactsDir,
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  function run(scenario: string, variantId = 'guided') {
    vi.stubEnv('FAKE_CHIMERA_SCENARIO', scenario);
    return runCase({
      task: findTasks(['edit-single-line'])[0]!,
      model: findModel('qwen3.5-9b'),
      variant: findVariant(variantId),
      settings,
    });
  }

  it('passes a run that did the task, and reports how the run went', async () => {
    const outcome = await run('solve-single-line');

    expect(outcome).toMatchObject({
      task: 'edit-single-line',
      category: 'edit',
      model: 'qwen3.5-9b',
      variant: 'guided',
      pass: true,
      finished: true,
      metrics: { finishReason: 'stop', steps: 2, toolCalls: 1 },
    });
  });

  it('fails a run that stopped without doing the task', async () => {
    const outcome = await run('do-nothing');

    expect(outcome.pass).toBe(false);
    expect(outcome.finished).toBe(true);
    expect(outcome.detail).toContain('The tests fail');
  });

  it('reports a run that asked for a permission as not finished', async () => {
    const outcome = await run('permission');

    expect(outcome).toMatchObject({ pass: false, finished: false, stopped: 'permission' });
  });

  it('keeps the events and the changes of the run for later inspection', async () => {
    const outcome = await run('solve-single-line');

    expect(outcome.artifacts).toBeDefined();
    const artifacts = outcome.artifacts!;
    expect(
      artifacts.startsWith(join(artifactsDir, 'qwen3.5-9b', 'guided', 'edit-single-line-')),
    ).toBe(true);
    expect(readFileSync(join(artifacts, 'events.ndjson'), 'utf8')).toContain('"run_finished"');
    expect(readFileSync(join(artifacts, 'changes.patch'), 'utf8')).toContain('+  timeoutMs: 8000,');
  });

  it('runs chimera with the model and the flags of the variant', async () => {
    const outcome = await run('echo', 'core-tools');

    const events = readFileSync(join(outcome.artifacts!, 'events.ndjson'), 'utf8');
    const echoed = JSON.parse(events.split('\n')[1]!) as { args: { argv: string[] } };
    expect(echoed.args.argv).toEqual(
      expect.arrayContaining(['--model', 'lm-studio/qwen/qwen3.5-9b', '--mode', 'eval-core']),
    );
  });

  it('removes the workspace and the home of the run', async () => {
    const before = new Set(readdirSync(tmpdir()));

    await run('solve-single-line');

    const left = readdirSync(tmpdir()).filter(
      (name) => name.startsWith('chimera-eval-') && !before.has(name),
    );
    expect(left).toEqual([]);
    expect(existsSync(artifactsDir)).toBe(true);
  });
});
