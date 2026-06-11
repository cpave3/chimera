import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/context';
import { LocalExecutor } from '../src/local-executor';
import { buildTaskListTool, TaskListStore } from '../src/task-list';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };
const asAny = (def: { tool: unknown }) => def.tool as AnyTool;

function makeCtx(store: TaskListStore): ToolContext {
  const executor = new LocalExecutor({ cwd: '/tmp' });
  return {
    sandboxExecutor: executor,
    hostExecutor: executor,
    sandboxMode: 'off',
    taskList: store,
  };
}

describe('task_list tool', () => {
  it('replaces the list and notifies the update hook', async () => {
    const onUpdate = vi.fn();
    const store = new TaskListStore({ onUpdate });
    const tool = asAny(buildTaskListTool(makeCtx(store)));

    const result = await tool.execute(
      {
        tasks: [
          { content: 'write failing test', status: 'completed' },
          { content: 'implement feature', status: 'in_progress' },
          { content: 'refactor', status: 'pending' },
        ],
      },
      {},
    );

    expect(result.ok).toBe(true);
    expect(store.get()).toHaveLength(3);
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls[0]![0]).toHaveLength(3);
  });

  it('seeds from existing tasks (session resume)', () => {
    const store = new TaskListStore({
      initial: [{ content: 'carried over', status: 'in_progress' }],
    });
    expect(store.get()).toEqual([{ content: 'carried over', status: 'in_progress' }]);
  });

  it('formatScrollback summarizes progress and the active task', async () => {
    const store = new TaskListStore({});
    const def = buildTaskListTool(makeCtx(store));
    const args = {
      tasks: [
        { content: 'write failing test', status: 'completed' as const },
        { content: 'implement feature', status: 'in_progress' as const },
        { content: 'refactor', status: 'pending' as const },
      ],
    };
    const display = def.formatScrollback!(args, { ok: true, total: 3, completed: 1 });
    expect(display.summary).toContain('1/3');
    expect(display.summary).toContain('implement feature');
  });
});
