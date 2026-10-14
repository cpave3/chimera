import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findTasks, TASKS } from '../src/tasks';
import { createWorkspace } from '../src/workspace';

describe('eval tasks', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'chimera-evals-tasks-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('have unique ids', () => {
    const ids = TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe.each(TASKS.map((task) => [task.id, task] as const))('%s', (_id, task) => {
    it('is not solved by a run that says nothing and changes nothing', async () => {
      const workspace = createWorkspace(task.files, root);

      const result = await task.check({ workspace, finalText: '' });

      expect(result.pass, result.detail).toBe(false);
    });

    it('is solved by its reference solution', async () => {
      const workspace = createWorkspace(task.files, root);

      const solution = task.solve(workspace);
      const result = await task.check({ workspace, finalText: solution?.finalText ?? 'Done.' });

      expect(result.pass, result.detail).toBe(true);
    });
  });
});

describe('eval task checks reject the usual wrong answers', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'chimera-evals-tasks-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function start(id: string) {
    const task = findTasks([id])[0]!;
    return { task, workspace: createWorkspace(task.files, root) };
  }

  it('fix-failing-test: a test edited to agree with the bug', async () => {
    const { task, workspace } = start('fix-failing-test');
    writeFileSync(
      join(workspace, 'test/pagination.test.js'),
      "import { test } from 'node:test';\ntest('nothing', () => {});\n",
    );

    expect((await task.check({ workspace, finalText: 'Fixed.' })).pass).toBe(false);
  });

  it('answer-question: the right answer from a run that also changed a file', async () => {
    const { task, workspace } = start('answer-question');
    const answer = task.solve(workspace)!.finalText;
    writeFileSync(join(workspace, 'src/billing/retry-policy.js'), '// tidied\n');

    const result = await task.check({ workspace, finalText: answer });

    expect(result).toEqual({
      pass: false,
      detail: 'Files changed: src/billing/retry-policy.js',
    });
  });

  it('scoped-change: the title changed along with a tidy-up of another line', async () => {
    const { task, workspace } = start('scoped-change');
    task.solve(workspace);
    const path = join(workspace, 'src/report.js');
    writeFileSync(path, readFileSync(path, 'utf8').replace('var unused = 0;', 'let unused = 0;'));

    const result = await task.check({ workspace, finalText: 'Done.' });

    expect(result).toEqual({ pass: false, detail: '2 lines changed; expected 1.' });
  });

  it('wrong-path: a new file at the path the user gave, with the real one left broken', async () => {
    const { task, workspace } = start('wrong-path');
    mkdirSync(join(workspace, 'src/utils'), { recursive: true });
    writeFileSync(
      join(workspace, 'src/utils/date.js'),
      'export function daysBetween(first, second) {\n  return Math.abs(second - first) / 86400000;\n}\n',
    );

    expect((await task.check({ workspace, finalText: 'Done.' })).pass).toBe(false);
  });

  it('edit-large-file: the status changed in every handler', async () => {
    const { task, workspace } = start('edit-large-file');
    const path = join(workspace, 'src/handlers.js');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('status: 200', 'status: 202'));

    const result = await task.check({ workspace, finalText: 'Done.' });

    expect(result).toEqual({ pass: false, detail: '120 lines changed; expected 1.' });
  });
});

describe('findTasks', () => {
  it('returns every task when no pattern is given', () => {
    expect(findTasks([])).toEqual(TASKS);
  });

  it('selects by id, by category and by a prefix with a star', () => {
    expect(findTasks(['edit-single-line']).map((task) => task.id)).toEqual(['edit-single-line']);
    expect(findTasks(['restrain']).every((task) => task.category === 'restrain')).toBe(true);
    expect(findTasks(['fix-*']).map((task) => task.id)).toEqual([
      'fix-failing-test',
      'fix-two-bugs',
    ]);
  });

  it('names the known tasks when a pattern matches nothing', () => {
    expect(() => findTasks(['nope'])).toThrow(/No task matches "nope"/);
  });
});
