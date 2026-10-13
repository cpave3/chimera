import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecResult, PermissionGate } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTools } from '../src/build';
import { LocalExecutor } from '../src/local-executor';
import { createOsSandbox } from '../src/os-sandbox';

const refused: ExecResult = {
  stdout: 'partial output',
  stderr: 'Read-only file system',
  exitCode: 1,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
};
const succeeded: ExecResult = { ...refused, stdout: 'host output', stderr: '', exitCode: 0 };
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chimera-auto-retry-'));
  mkdirSync(join(root, 'tmp'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function setup(network: 'on' | 'off' = 'on') {
  const permissionGate: PermissionGate = {
    request: vi.fn(async () => ({ decision: 'allow', remembered: false })),
    check: async () => null,
    requestRememberedBypass: vi.fn(async () => ({ decision: 'allow', remembered: true })),
    addRule: () => {},
    listRules: () => [],
    removeRule: () => {},
  };
  const executor = new LocalExecutor({ cwd: root });
  const execute = vi
    .spyOn(executor, 'exec')
    .mockResolvedValueOnce(refused)
    .mockResolvedValue(succeeded);
  const bash = buildTools({
    sandboxExecutor: executor,
    hostExecutor: executor,
    permissionGate,
    sandboxMode: 'off',
    osSandbox: createOsSandbox('bwrap', {
      cwd: root,
      tmp: join(root, 'tmp'),
      writablePaths: [],
      readOnlyPaths: [],
      network,
    }),
  }).tools.bash as unknown as {
    execute: (args: object, options: object) => Promise<Record<string, unknown>>;
  };
  return { bash, execute, permissionGate };
}

describe('automatic OS sandbox retry', () => {
  it('retries only once and retains the original failure if the host attempt also fails', async () => {
    const { bash, execute, permissionGate } = setup();
    execute.mockReset().mockResolvedValue(refused);
    const result = await bash.execute({ command: 'legato plan status' }, { toolCallId: 'call' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]![0]).toContain('bwrap');
    expect(execute.mock.calls[1]![0]).toBe('legato plan status');
    expect(permissionGate.requestRememberedBypass).toHaveBeenCalledOnce();
    expect(permissionGate.requestRememberedBypass).toHaveBeenCalledWith(
      expect.objectContaining({
        unsandboxed: true,
        toolCallId: 'call',
        reason: expect.stringContaining('Automatic host retry'),
      }),
    );
    expect(result).toMatchObject({
      exit_code: 1,
      sandbox_retry: {
        initial_stdout: refused.stdout,
        initial_stderr: refused.stderr,
        initial_exit_code: 1,
      },
    });
  });

  it.each([
    { ...refused, stderr: 'test assertion failed' },
    { ...refused, timedOut: true },
    { ...refused, exitCode: 0 },
  ])('does not retry unrelated failures, timeouts or success: %j', async (result) => {
    const { bash, execute, permissionGate } = setup();
    execute.mockReset().mockResolvedValue(result);
    const returned = await bash.execute({ command: 'legato plan status' }, {});
    expect(execute).toHaveBeenCalledOnce();
    expect(permissionGate.requestRememberedBypass).not.toHaveBeenCalled();
    expect(returned).not.toHaveProperty('sandbox_retry');
  });

  it('retains the sandbox failure when there is no saved authorization', async () => {
    const { bash, execute, permissionGate } = setup();
    vi.mocked(permissionGate.requestRememberedBypass).mockResolvedValue(null);
    const result = await bash.execute({ command: 'legato plan status' }, {});
    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ exit_code: 1, sandbox: expect.stringContaining('unsandboxed') });
    expect(result).not.toHaveProperty('sandbox_retry');
  });

  it('does not retry a command that already ran unsandboxed', async () => {
    const { bash, execute, permissionGate } = setup();
    await bash.execute(
      { command: 'legato plan status', unsandboxed: true, reason: 'write host state' },
      {},
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(permissionGate.requestRememberedBypass).not.toHaveBeenCalled();
  });

  it('does not relaunch after interruption during authorization', async () => {
    const { bash, execute, permissionGate } = setup();
    const controller = new AbortController();
    vi.mocked(permissionGate.requestRememberedBypass).mockImplementation(async () => {
      controller.abort();
      return { decision: 'allow', remembered: true };
    });
    await bash.execute({ command: 'legato plan status' }, { abortSignal: controller.signal });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('shares the foreground timeout budget with the retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { bash, execute } = setup();
    execute
      .mockReset()
      .mockImplementationOnce(async () => {
        vi.setSystemTime(1040);
        return refused;
      })
      .mockResolvedValue(succeeded);
    const result = await bash.execute({ command: 'legato plan status', timeout_ms: 100 }, {});
    expect(result).toMatchObject({ exit_code: 0 });
    expect(execute.mock.calls[1]![1]?.timeoutMs).toBe(60);
  });

  it('does not relaunch when authorization exhausts the timeout budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { bash, execute, permissionGate } = setup();
    vi.mocked(permissionGate.requestRememberedBypass).mockImplementation(async () => {
      vi.setSystemTime(1101);
      return { decision: 'allow', remembered: true };
    });
    const result = await bash.execute({ command: 'legato plan status', timeout_ms: 100 }, {});
    expect(execute).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty('sandbox_retry');
  });

  it.each([
    'on',
    'off',
  ] as const)('retries network failures only when the sandbox network is off (%s)', async (network) => {
    const { bash, execute } = setup(network);
    execute
      .mockReset()
      .mockResolvedValueOnce({ ...refused, stderr: 'EAI_AGAIN' })
      .mockResolvedValue(succeeded);
    await bash.execute({ command: 'legato plan status' }, {});
    expect(execute).toHaveBeenCalledTimes(network === 'off' ? 2 : 1);
  });
});
