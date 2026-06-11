import type { TaskItem } from '@chimera/core';
import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { clip } from './format';

export interface TaskListStoreOptions {
  initial?: TaskItem[];
  /** Fired with the full list after every replacement. */
  onUpdate?: (tasks: TaskItem[]) => void;
}

/**
 * Per-session task list written by the model through the task_list tool.
 * Replace-whole-list semantics: the model owns the list and rewrites it as
 * work progresses. The embedder's onUpdate hook persists the list to the
 * session and pushes a task_list_updated event for the TUI.
 */
export class TaskListStore {
  private items: TaskItem[];
  private readonly onUpdate: ((tasks: TaskItem[]) => void) | undefined;

  constructor(opts: TaskListStoreOptions) {
    this.items = opts.initial ? [...opts.initial] : [];
    this.onUpdate = opts.onUpdate;
  }

  get(): TaskItem[] {
    return [...this.items];
  }

  set(tasks: TaskItem[]): void {
    this.items = [...tasks];
    this.onUpdate?.(this.get());
  }
}

const TASK_SCHEMA = z.object({
  tasks: z
    .array(
      z.object({
        content: z.string().describe('Imperative description of the task.'),
        status: z.enum(['pending', 'in_progress', 'completed']),
      }),
    )
    .describe('The full task list; replaces the previous list entirely.'),
});
type TaskArgs = z.infer<typeof TASK_SCHEMA>;
type TaskResult = { ok: boolean; total: number; completed: number };

export function buildTaskListTool(ctx: ToolContext) {
  return defineTool<TaskArgs, TaskResult>({
    description:
      'Maintain a task list for multi-step work. Pass the FULL list every time — it ' +
      'replaces the previous one. Use for work with 3+ distinct steps: write the plan ' +
      'as pending tasks, mark exactly one in_progress while working on it, and mark ' +
      'tasks completed as soon as they are done. The list survives context compaction, ' +
      'so keep it accurate — it is your durable record of where the work stands.',
    inputSchema: TASK_SCHEMA,
    execute: async (args) => {
      const store = ctx.taskList;
      if (!store) {
        return { ok: false, total: 0, completed: 0 };
      }
      store.set(args.tasks);
      return {
        ok: true,
        total: args.tasks.length,
        completed: args.tasks.filter((task) => task.status === 'completed').length,
      };
    },
    formatScrollback: (args, result) => {
      const active = args.tasks.find((task) => task.status === 'in_progress');
      const completed =
        result?.completed ?? args.tasks.filter((task) => task.status === 'completed').length;
      const progress = `${completed}/${args.tasks.length}`;
      if (active) {
        return { summary: `${progress} done → ${clip(active.content, 50)}` };
      }
      return { summary: `${progress} done` };
    },
  });
}
