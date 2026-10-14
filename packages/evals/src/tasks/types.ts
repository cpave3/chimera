import type { WorkspaceFiles } from '../workspace';

export type TaskCategory = 'edit' | 'navigate' | 'verify' | 'recover' | 'restrain' | 'build';

export interface CheckContext {
  workspace: string;
  /** The last assistant message of the run. */
  finalText: string;
}

export interface CheckResult {
  pass: boolean;
  detail: string;
}

export interface EvalTask {
  id: string;
  category: TaskCategory;
  /** The model behaviour this task shows. */
  probes: string;
  prompt: string;
  files: WorkspaceFiles;
  /** Decides, from the workspace and the final message, whether the task was done. */
  check: (context: CheckContext) => CheckResult | Promise<CheckResult>;
  /**
   * Applies a correct solution. The task self-test uses it to prove that the
   * check accepts a right answer. Returns the final message for a task whose
   * check reads it.
   */
  solve: (workspace: string) => { finalText: string } | undefined;
}
