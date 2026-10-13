import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionGate, PermissionRequest } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { BackgroundProcessManager } from '../src/background';
import { buildTools } from '../src/build';
import type { ToolContext } from '../src/context';
import { LocalExecutor } from '../src/local-executor';
import { createOsSandbox } from '../src/os-sandbox';

type ExecutableTool = {
  inputSchema: z.ZodType;
  execute: (args: unknown, opts: object) => Promise<any>;
};

describe('Codex Bash adapter', () => {
  let root: string;
  let context: ToolContext;
  let requests: PermissionRequest[];
  let backgroundProcesses: BackgroundProcessManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-codex-adapter-'));
    const cwd = join(root, 'project');
    const sandboxTmp = join(root, 'tmp');
    await mkdir(cwd);
    await mkdir(sandboxTmp);
    requests = [];
    const permissionGate: PermissionGate = {
      request: async (request) => {
        requests.push(request);
        return { decision: 'allow', remembered: false };
      },
      check: () => null,
      addRule: () => {},
      listRules: () => [],
      removeRule: () => {},
    };
    const executor = new LocalExecutor({ cwd });
    backgroundProcesses = new BackgroundProcessManager({ cwd });
    context = {
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
      toolCallShape: 'codex',
      permissionGate,
      backgroundProcesses,
      osSandbox: createOsSandbox('bwrap', {
        cwd,
        tmp: sandboxTmp,
        writablePaths: [],
        readOnlyPaths: [],
        network: 'off',
      }),
    };
  });

  afterEach(async () => {
    await backgroundProcesses.killAll();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    true,
    false,
  ])('forwards an approved foreground sandbox escape with background tools enabled=%s', async (withBackgroundTools) => {
    const bash = buildTools({
      ...context,
      backgroundProcesses: withBackgroundTools ? backgroundProcesses : undefined,
    }).tools.bash as unknown as ExecutableTool;
    const target = join(root, 'foreground.txt');
    const command = `printf foreground > '${target}'`;
    const reason = 'write outside the project and sandbox temp directory';
    const result = await bash.execute(
      bash.inputSchema.parse({ command, target: 'host', unsandboxed: true, reason }),
      { toolCallId: 'foreground-call' },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command,
      target: 'host',
      unsandboxed: true,
      reason,
      toolCallId: 'foreground-call',
    });
    expect(requests[0]!.osSandbox).toBeUndefined();
    expect(result.exit_code).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('foreground');
  });

  it('forwards an approved background sandbox escape to host execution', async () => {
    const tools = buildTools(context).tools as unknown as Record<string, ExecutableTool>;
    const target = join(root, 'background.txt');
    const command = `printf background > '${target}'`;
    const reason = 'background command must write outside the sandbox';
    const started = await tools.bash.execute(
      tools.bash.inputSchema.parse({
        command,
        target: 'host',
        unsandboxed: true,
        reason,
        run_in_background: true,
      }),
      { toolCallId: 'background-call' },
    );

    expect(started.shell_id).toMatch(/^shell_/);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command,
      target: 'host',
      unsandboxed: true,
      reason,
      toolCallId: 'background-call',
    });
    expect(requests[0]!.osSandbox).toBeUndefined();
    let output = await tools.bash_output.execute({ shell_id: started.shell_id }, {});
    const deadline = Date.now() + 5_000;
    while (output.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      output = await tools.bash_output.execute({ shell_id: started.shell_id }, {});
    }
    expect(output).toMatchObject({ status: 'exited', exit_code: 0 });
    expect(await readFile(target, 'utf8')).toBe('background');
  });

  it('forwards an explicit sandbox target instead of starting a host background command', async () => {
    const bash = buildTools(context).tools.bash as unknown as ExecutableTool;
    const result = await bash.execute(
      bash.inputSchema.parse({
        command: 'printf unexpected',
        target: 'sandbox',
        run_in_background: true,
      }),
      {},
    );

    expect(result).toMatchObject({ exit_code: -1 });
    expect(result.stderr).toContain('background commands only run on the host');
    expect(requests).toEqual([]);
  });

  it('keeps timeout in seconds when executing foreground commands', async () => {
    const bash = buildTools({ ...context, osSandbox: undefined }).tools
      .bash as unknown as ExecutableTool;
    const completed = await bash.execute(
      bash.inputSchema.parse({ command: 'sleep 0.1; printf done', timeout: 1 }),
      {},
    );
    const timedOut = await bash.execute(
      bash.inputSchema.parse({ command: 'sleep 1', timeout: 0.05 }),
      {},
    );

    expect(completed).toMatchObject({ stdout: 'done', exit_code: 0, timed_out: false });
    expect(timedOut.timed_out).toBe(true);
  });

  it('preserves the native sandbox-aware Bash description', () => {
    const native = buildTools({ ...context, toolCallShape: 'chimera' }).tools.bash;
    const codex = buildTools(context).tools.bash;

    expect(codex.description).toBe(native.description);
    expect(codex.description).toContain('unsandboxed: true');
    expect(codex.description).toContain('no network access');
  });
});
