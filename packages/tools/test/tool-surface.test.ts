import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundProcessManager } from '../src/background';
import { buildTools } from '../src/build';
import type { ToolContext } from '../src/context';
import { LocalExecutor } from '../src/local-executor';
import { TaskListStore } from '../src/task-list';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };

describe('tool surface', () => {
  let root: string;
  let backgroundProcesses: BackgroundProcessManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-tool-surface-'));
    backgroundProcesses = new BackgroundProcessManager({ cwd: root });
  });

  afterEach(async () => {
    await backgroundProcesses.killAll();
    await rm(root, { recursive: true, force: true });
  });

  /** A context with every optional capability switched on. */
  function fullContext(overrides: Partial<ToolContext> = {}): ToolContext {
    const executor = new LocalExecutor({ cwd: root });
    return {
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
      backgroundProcesses,
      webSearch: { name: 'stub', search: async () => [] },
      taskList: new TaskListStore({ initial: [], onUpdate: () => {} }),
      recall: { get: async () => null },
      requestUserInput: async () => {},
      ...overrides,
    };
  }

  it('gives every built-in tool a one-line prompt snippet', () => {
    const built = buildTools(fullContext());

    for (const name of Object.keys(built.tools)) {
      const snippet = built.snippets[name];
      expect(snippet, `snippet for ${name}`).toBeTruthy();
      expect(snippet, `snippet for ${name}`).not.toContain('\n');
    }
  });

  it('keeps every tool under the codex shape, renaming only glob', () => {
    const native = Object.keys(buildTools(fullContext()).tools);
    const codex = Object.keys(buildTools(fullContext({ toolCallShape: 'codex' })).tools);

    const expected = [...native.filter((name) => name !== 'glob'), 'find', 'ls'].sort();
    expect(codex.sort()).toEqual(expected);
  });

  it('gives every codex-shape tool a prompt snippet', () => {
    const built = buildTools(fullContext({ toolCallShape: 'codex' }));

    for (const name of Object.keys(built.tools)) {
      expect(built.snippets[name], `snippet for ${name}`).toBeTruthy();
    }
  });

  it('lets the codex bash tool start a background process', async () => {
    const tools = buildTools(fullContext({ toolCallShape: 'codex' })).tools as unknown as Record<
      string,
      AnyTool
    >;

    const result = await tools.bash!.execute({ command: 'sleep 5', run_in_background: true }, {});

    expect(result.shell_id).toMatch(/^shell_/);
  });
});
