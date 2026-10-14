import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEvalHome } from './home';
import { type RunMetrics, summarizeRun } from './metrics';
import type { EvalModel } from './models';
import { runChimera } from './run-chimera';
import type { EvalTask, TaskCategory } from './tasks';
import type { Variant } from './variants';
import { createWorkspace } from './workspace';

export interface RunSettings {
  /** The chimera invocation, for example `['node', '/repo/packages/cli/dist/bin.js']`. */
  command: string[];
  /** The OpenAI-compatible endpoint of the local server. */
  baseUrl: string;
  contextWindow: number;
  maxSteps: number;
  timeoutMs: number;
  /** Where to keep the events and the changes of each run. Nothing is kept without it. */
  artifactsDir?: string;
}

export interface CaseOptions {
  task: EvalTask;
  model: EvalModel;
  variant: Variant;
  settings: RunSettings;
}

export interface CaseOutcome {
  task: string;
  category: TaskCategory;
  model: string;
  variant: string;
  /** The task's check accepted the workspace and the final message. */
  pass: boolean;
  detail: string;
  /** The run ended by itself, with the reason `stop`. */
  finished: boolean;
  stopped?: 'timeout' | 'permission';
  exitCode: number | null;
  seconds: number;
  metrics: RunMetrics;
  /** The directory with `events.ndjson`, `stderr.txt` and `changes.patch`. */
  artifacts?: string;
}

function workspaceChanges(workspace: string): string {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: workspace, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  try {
    git('add', '--all');
    return git('diff', '--cached');
  } catch (error) {
    return `git could not report the changes: ${String(error)}\n`;
  }
}

/** Runs one task once, with one model and one variant, in a new workspace and a new home. */
export async function runCase(options: CaseOptions): Promise<CaseOutcome> {
  const { task, model, variant, settings } = options;
  const root = mkdtempSync(join(tmpdir(), 'chimera-eval-'));
  try {
    const workspace = createWorkspace(task.files, root);
    const home = join(root, 'home');
    const flags = writeEvalHome({
      home,
      baseUrl: settings.baseUrl,
      modelId: model.key,
      contextWindow: settings.contextWindow,
      variant,
    });

    const run = await runChimera({
      command: settings.command,
      cwd: workspace,
      home,
      flags,
      prompt: task.prompt,
      maxSteps: settings.maxSteps,
      timeoutMs: settings.timeoutMs,
    });
    const metrics = summarizeRun(run.events);

    let artifacts: string | undefined;
    if (settings.artifactsDir) {
      const cellDir = join(settings.artifactsDir, model.id, variant.id);
      mkdirSync(cellDir, { recursive: true });
      artifacts = mkdtempSync(join(cellDir, `${task.id}-`));
      writeFileSync(
        join(artifacts, 'events.ndjson'),
        run.events.map((event) => `${JSON.stringify(event)}\n`).join(''),
      );
      writeFileSync(join(artifacts, 'stderr.txt'), run.stderr);
      // Before the check: the check writes its own test files to the workspace.
      writeFileSync(join(artifacts, 'changes.patch'), workspaceChanges(workspace));
    }

    const result = await task.check({ workspace, finalText: metrics.finalText });
    return {
      task: task.id,
      category: task.category,
      model: model.id,
      variant: variant.id,
      pass: result.pass,
      detail: result.detail,
      finished: run.stopped === undefined && metrics.finishReason === 'stop',
      stopped: run.stopped,
      exitCode: run.exitCode,
      seconds: Math.round(run.durationMs / 100) / 10,
      metrics,
      artifacts,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
