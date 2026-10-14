import { BUILD_TASKS } from './build';
import { EDIT_TASKS } from './edit';
import { NAVIGATE_TASKS } from './navigate';
import { RECOVER_TASKS } from './recover';
import { RESTRAIN_TASKS } from './restrain';
import type { EvalTask } from './types';
import { VERIFY_TASKS } from './verify';

export type { CheckContext, CheckResult, EvalTask, TaskCategory } from './types';

export const TASKS: EvalTask[] = [
  ...EDIT_TASKS,
  ...NAVIGATE_TASKS,
  ...VERIFY_TASKS,
  ...RECOVER_TASKS,
  ...RESTRAIN_TASKS,
  ...BUILD_TASKS,
];

function matches(task: EvalTask, pattern: string): boolean {
  if (pattern.endsWith('*')) return task.id.startsWith(pattern.slice(0, -1));
  return task.id === pattern || task.category === pattern;
}

/** Tasks selected by id, by category, or by an id prefix that ends in `*`. No pattern selects all. */
export function findTasks(patterns: string[]): EvalTask[] {
  if (patterns.length === 0) return TASKS;
  for (const pattern of patterns) {
    if (!TASKS.some((task) => matches(task, pattern))) {
      const known = TASKS.map((task) => task.id).join(', ');
      throw new Error(`No task matches "${pattern}". Known tasks: ${known}`);
    }
  }
  return TASKS.filter((task) => patterns.some((pattern) => matches(task, pattern)));
}
