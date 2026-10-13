import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionGate, PermissionRequest, PermissionResolution } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundProcessManager } from '../src/background';
import { buildBashKillTool, buildBashOutputTool } from '../src/background-tools';
import { buildBashTool } from '../src/bash';
import type { ToolContext } from '../src/context';
import { LocalExecutor } from '../src/local-executor';
import { createOsSandbox } from '../src/os-sandbox';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };

const asAny = (def: { tool: unknown }) => def.tool as AnyTool;

class FakeGate implements PermissionGate {
  request = vi.fn(
    async (_req: PermissionRequest): Promise<PermissionResolution> => ({
      decision: 'allow',
      remembered: false,
    }),
  );
  check = vi.fn(async () => null);
  requestRememberedBypass = vi.fn(async (): Promise<PermissionResolution | null> => null);
  addRule = vi.fn();
  listRules = vi.fn(() => []);
  removeRule = vi.fn();
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('bash tool — run_in_background', () => {
  let root: string;
  let manager: BackgroundProcessManager;
  let gate: FakeGate;
  let ctx: ToolContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-bgtool-'));
    manager = new BackgroundProcessManager({ cwd: root });
    gate = new FakeGate();
    const executor = new LocalExecutor({ cwd: root });
    ctx = {
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
      permissionGate: gate,
      backgroundProcesses: manager,
    };
  });

  afterEach(async () => {
    manager.killAll();
    await rm(root, { recursive: true, force: true });
  });

  it('returns a shell id immediately and gates the launch', async () => {
    const bash = asAny(buildBashTool(ctx));
    const result = await bash.execute({ command: 'sleep 5', run_in_background: true }, {});
    expect(result.shell_id).toMatch(/^shell_\d+$/);
    expect(result.exit_code).toBeUndefined();
    expect(gate.request).toHaveBeenCalledOnce();
    expect(gate.request.mock.calls[0]![0].command).toBe('sleep 5');
    expect(manager.get(result.shell_id)?.status).toBe('running');
  });

  it.each([
    'before',
    'during',
  ])('suppresses a host retry when interrupted %s authorization', async (interruption) => {
    const controller = new AbortController();
    ctx.osSandbox = {
      ...createOsSandbox('bwrap', {
        cwd: root,
        tmp: root,
        writablePaths: [],
        readOnlyPaths: [],
        network: 'on',
      }),
      wrap: () => "printf 'Read-only file system' >&2; exit 1",
    };
    gate.requestRememberedBypass.mockImplementation(async () => {
      if (interruption === 'during') controller.abort();
      return { decision: 'allow', remembered: true };
    });
    const bash = asAny(buildBashTool(ctx));
    const launched = await bash.execute(
      { command: 'touch host-marker', run_in_background: true },
      {
        abortSignal: controller.signal,
      },
    );
    if (interruption === 'before') controller.abort();
    await until(() => manager.get(launched.shell_id)?.status === 'exited');
    expect(manager.get(launched.shell_id)?.exitCode).toBe(1);
    expect(manager.readOutput(launched.shell_id)).not.toHaveProperty('sandboxRetry');
    await expect(access(join(root, 'host-marker'))).rejects.toThrow();
    expect(gate.requestRememberedBypass).toHaveBeenCalledTimes(interruption === 'before' ? 0 : 1);
  });

  it.each([
    { stderr: 'test assertion failed', grant: 'allow', authorizations: 0 },
    { stderr: 'EAI_AGAIN', grant: 'allow', authorizations: 0 },
    { stderr: 'Read-only file system', grant: null, authorizations: 1 },
    { stderr: 'Read-only file system', grant: 'deny', authorizations: 1 },
  ] as const)('does not retry an unrelated or unauthorized background failure: %j', async ({
    stderr,
    grant,
    authorizations,
  }) => {
    ctx.osSandbox = {
      ...createOsSandbox('bwrap', {
        cwd: root,
        tmp: root,
        writablePaths: [],
        readOnlyPaths: [],
        network: 'on',
      }),
      wrap: () => `printf '${stderr}' >&2; exit 1`,
    };
    gate.requestRememberedBypass.mockResolvedValue(
      grant ? { decision: grant, remembered: true } : null,
    );
    const bash = asAny(buildBashTool(ctx));
    const launched = await bash.execute(
      { command: 'touch host-marker', run_in_background: true },
      {},
    );
    await until(() => manager.get(launched.shell_id)?.status === 'exited');
    expect(manager.get(launched.shell_id)?.exitCode).toBe(1);
    expect(manager.readOutput(launched.shell_id)).toMatchObject({ stderr });
    await expect(access(join(root, 'host-marker'))).rejects.toThrow();
    expect(gate.requestRememberedBypass).toHaveBeenCalledTimes(authorizations);
  });

  it('does not retry an already-unsandboxed background command', async () => {
    ctx.osSandbox = createOsSandbox('bwrap', {
      cwd: root,
      tmp: root,
      writablePaths: [],
      readOnlyPaths: [],
      network: 'on',
    });
    const bash = asAny(buildBashTool(ctx));
    const launched = await bash.execute(
      {
        command: "printf 'Read-only file system' >&2; exit 1",
        run_in_background: true,
        unsandboxed: true,
        reason: 'host state',
      },
      {},
    );
    await until(() => manager.get(launched.shell_id)?.status === 'exited');
    expect(manager.get(launched.shell_id)?.exitCode).toBe(1);
    expect(gate.requestRememberedBypass).not.toHaveBeenCalled();
  });

  it('refuses background launch when the gate denies', async () => {
    gate.request.mockResolvedValueOnce({
      decision: 'deny',
      remembered: false,
      denialSource: 'user',
    });
    const bash = asAny(buildBashTool(ctx));
    const result = await bash.execute({ command: 'sleep 5', run_in_background: true }, {});
    expect(result.shell_id).toBeUndefined();
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/denied/);
  });

  it('refuses background launch for the sandbox target', async () => {
    const bash = asAny(buildBashTool({ ...ctx, sandboxMode: 'bind' }));
    const result = await bash.execute(
      { command: 'sleep 5', run_in_background: true, target: 'sandbox' },
      {},
    );
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/host/);
  });

  it('refuses background launch when no manager is registered', async () => {
    const bash = asAny(buildBashTool({ ...ctx, backgroundProcesses: undefined }));
    const result = await bash.execute({ command: 'sleep 5', run_in_background: true }, {});
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/not available/);
  });

  it('bash_output returns incremental output and final status', async () => {
    const bash = asAny(buildBashTool(ctx));
    const bashOutput = asAny(buildBashOutputTool(ctx));
    const launched = await bash.execute({ command: 'echo ready', run_in_background: true }, {});

    await until(() => manager.get(launched.shell_id)?.status === 'exited');
    const read = await bashOutput.execute({ shell_id: launched.shell_id }, {});
    expect(read.stdout).toContain('ready');
    expect(read.status).toBe('exited');
    expect(read.exit_code).toBe(0);

    const unknown = await bashOutput.execute({ shell_id: 'shell_999' }, {});
    expect(unknown.error).toMatch(/no background process/i);
  });

  it('bash_output preserves retry metadata after polling and reports running through authorization', async () => {
    const bashOutput = asAny(buildBashOutputTool(ctx));
    let authorize!: (value: { shellCommand: string; reason: string }) => void;
    const authorization = new Promise<{ shellCommand: string; reason: string }>((resolve) => {
      authorize = resolve;
    });
    const retryOnFailure = vi.fn(() => authorization);
    const launched = manager.launch(
      'echo before >&2; while [ ! -f go ]; do sleep 0.05; done; echo after >&2; exit 3',
      { retryOnFailure },
    );
    let polledStderr = '';
    await until(() => {
      polledStderr += manager.readOutput(launched.id)?.stderr ?? '';
      return polledStderr.includes('before');
    });
    await new LocalExecutor({ cwd: root }).writeFile('go', '');
    await until(() => retryOnFailure.mock.calls.length === 1);
    expect(retryOnFailure).toHaveBeenCalledExactlyOnceWith({
      exitCode: 3,
      stderr: 'before\nafter\n',
    });
    const pending = await bashOutput.execute({ shell_id: launched.id }, {});
    expect(pending).toMatchObject({ status: 'running', exit_code: null, stderr: 'after\n' });
    authorize({
      shellCommand: 'while [ ! -f finish ]; do sleep 0.05; done; echo recovered',
      reason: 'sandbox unavailable',
    });
    await until(() => manager.get(launched.id)?.sandboxRetry !== undefined);
    const retrying = await bashOutput.execute({ shell_id: launched.id }, {});
    expect(retrying).toMatchObject({
      status: 'running',
      exit_code: null,
      sandbox_retry: { reason: 'sandbox unavailable', initial_exit_code: 3 },
    });
    expect(retrying.stderr).toMatch(/automatic host.retry/i);
    await new LocalExecutor({ cwd: root }).writeFile('finish', '');
    await until(() => manager.get(launched.id)?.status === 'exited');
    const output = await bashOutput.execute({ shell_id: launched.id }, {});
    expect(output).toMatchObject({
      stdout: 'recovered\n',
      exit_code: 0,
      sandbox_retry: { reason: 'sandbox unavailable', initial_exit_code: 3 },
    });
    expect(output.stderr).toBe('');
    const consumed = await bashOutput.execute({ shell_id: launched.id }, {});
    expect(consumed.stdout).toBe('');
    expect(consumed.stderr).toBe('');
    expect(consumed.sandbox_retry).toEqual(output.sandbox_retry);
  });

  it('bash_kill terminates a running background process', async () => {
    const bash = asAny(buildBashTool(ctx));
    const bashKill = asAny(buildBashKillTool(ctx));
    const launched = await bash.execute({ command: 'sleep 30', run_in_background: true }, {});

    const killed = await bashKill.execute({ shell_id: launched.shell_id }, {});
    expect(killed.killed).toBe(true);
    await until(() => manager.get(launched.shell_id)?.status === 'killed');

    const again = await bashKill.execute({ shell_id: launched.shell_id }, {});
    expect(again.killed).toBe(false);
  });
});
