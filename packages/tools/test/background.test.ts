import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundProcessManager } from '../src/background';
import { LocalExecutor } from '../src/local-executor';

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('BackgroundProcessManager', () => {
  let root: string;
  let manager: BackgroundProcessManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-bg-'));
    manager = new BackgroundProcessManager({ cwd: root });
  });

  afterEach(async () => {
    manager.killAll();
    await rm(root, { recursive: true, force: true });
  });

  it('launches a process and returns its output incrementally', async () => {
    const launched = manager.launch(
      'echo first; while [ ! -f go ]; do sleep 0.05; done; echo second',
    );
    expect(launched.id).toMatch(/^shell_\d+$/);
    expect(launched.status).toBe('running');

    let accumulated = '';
    await until(() => {
      accumulated += manager.readOutput(launched.id)?.stdout ?? '';
      return accumulated.includes('first');
    });
    expect(accumulated).not.toContain('second');

    await new LocalExecutor({ cwd: root }).writeFile('go', '');
    await until(() => manager.get(launched.id)?.status === 'exited');
    const finalRead = manager.readOutput(launched.id);
    expect(finalRead?.stdout).toContain('second');
    expect(finalRead?.stdout).not.toContain('first');
    expect(finalRead?.exitCode).toBe(0);
  });

  it('fires onExit with the exit code when the process finishes', async () => {
    const notices: unknown[] = [];
    const notifying = new BackgroundProcessManager({
      cwd: root,
      onExit: (notice) => notices.push(notice),
    });
    const launched = notifying.launch('exit 3');
    await until(() => notices.length === 1);
    expect(notices[0]).toMatchObject({
      shellId: launched.id,
      command: 'exit 3',
      status: 'exited',
      exitCode: 3,
    });
  });

  it('kill terminates a running process and marks it killed', async () => {
    const launched = manager.launch('sleep 30');
    expect(manager.kill(launched.id)).toBe(true);
    await until(() => manager.get(launched.id)?.status !== 'running');
    expect(manager.get(launched.id)?.status).toBe('killed');
    expect(manager.kill(launched.id)).toBe(false);
  });

  it('readOutput returns null for unknown ids', () => {
    expect(manager.readOutput('shell_999')).toBeNull();
  });

  it('retries under the same id once, retaining output and issuing one terminal notice', async () => {
    const onExit = vi.fn();
    manager = new BackgroundProcessManager({ cwd: root, onExit });
    const retryOnFailure = vi.fn(async () => ({
      shellCommand: 'echo retry; echo retry-error >&2; exit 7',
      reason: 'sandbox blocked',
    }));
    const launched = manager.launch('echo original; echo initial-error >&2; exit 3', {
      retryOnFailure,
    });
    await until(() => manager.get(launched.id)?.status === 'exited');
    expect(retryOnFailure).toHaveBeenCalledExactlyOnceWith({
      exitCode: 3,
      stderr: 'initial-error\n',
    });
    expect(manager.list()).toHaveLength(1);
    expect(manager.get(launched.id)).toMatchObject({
      command: launched.command,
      exitCode: 7,
      sandboxRetry: { reason: 'sandbox blocked', initialExitCode: 3 },
    });
    const output = manager.readOutput(launched.id)!;
    expect(output.stdout).toBe('original\nretry\n');
    expect(output.stderr).toContain('initial-error');
    expect(output.stderr).toContain('retry-error');
    expect(output.stderr).toMatch(/automatic host.retry/i);
    expect(output.sandboxRetry).toEqual({ reason: 'sandbox blocked', initialExitCode: 3 });
    expect(onExit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ exitCode: 7 }));
  });

  it.each([
    'kill',
    'killAll',
  ] as const)('%s cancels pending authorization without relaunch', async (action) => {
    const onExit = vi.fn();
    manager = new BackgroundProcessManager({ cwd: root, onExit });
    let authorize!: (value: { shellCommand: string; reason: string }) => void;
    const authorization = new Promise<{ shellCommand: string; reason: string }>((resolve) => {
      authorize = resolve;
    });
    const retryOnFailure = vi.fn(() => authorization);
    const launched = manager.launch('exit 3', { retryOnFailure });
    await until(() => retryOnFailure.mock.calls.length === 1);
    expect(manager.get(launched.id)?.status).toBe('running');
    expect(manager.readOutput(launched.id)?.exitCode).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
    if (action === 'kill') expect(manager.kill(launched.id)).toBe(true);
    else manager.killAll();
    expect(manager.get(launched.id)?.status).toBe('killed');
    authorize({ shellCommand: 'echo should-not-run', reason: 'allowed' });
    await new Promise((r) => setTimeout(r, 50));
    expect(manager.readOutput(launched.id)?.stdout).toBe('');
    expect(manager.get(launched.id)?.sandboxRetry).toBeUndefined();
    expect(onExit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'killed' }));
  });

  it('surfaces authorization exceptions even when stderr reached its cap', async () => {
    manager = new BackgroundProcessManager({ cwd: root, maxOutputBytes: 4 });
    const retryOnFailure = vi.fn(async () => {
      throw new Error('authorization unavailable');
    });
    const launched = manager.launch('printf abcdef >&2; exit 4', { retryOnFailure });
    await until(() => manager.get(launched.id)?.status === 'exited');
    const output = manager.readOutput(launched.id)!;
    expect(output.stderr).toContain('abcd');
    expect(output.stderr).toContain('authorization unavailable');
    expect(output.exitCode).toBe(4);
    expect(output.truncated).toBe(true);
    expect(output.sandboxRetry).toBeUndefined();
    expect(retryOnFailure).toHaveBeenCalledExactlyOnceWith({ exitCode: 4, stderr: 'abcd' });
  });

  it('settles the original failure when retry is blocked', async () => {
    const retryOnFailure = vi.fn(async () => null);
    const launched = manager.launch('echo denied >&2; exit 5', { retryOnFailure });
    await until(() => manager.get(launched.id)?.status === 'exited');
    expect(retryOnFailure).toHaveBeenCalledExactlyOnceWith({ exitCode: 5, stderr: 'denied\n' });
    expect(manager.readOutput(launched.id)).toMatchObject({ stderr: 'denied\n', exitCode: 5 });
    expect(manager.get(launched.id)?.sandboxRetry).toBeUndefined();
  });

  it('bounds classifier stderr across destructive polling', async () => {
    manager = new BackgroundProcessManager({ cwd: root, maxOutputBytes: 4 });
    const retryOnFailure = vi.fn(async () => null);
    const launched = manager.launch(
      'printf abc >&2; while [ ! -f go ]; do sleep 0.05; done; printf def >&2; exit 6',
      { retryOnFailure },
    );
    let stderr = '';
    await until(() => {
      stderr += manager.readOutput(launched.id)?.stderr ?? '';
      return stderr === 'abc';
    });
    await new LocalExecutor({ cwd: root }).writeFile('go', '');
    await until(() => manager.get(launched.id)?.status === 'exited');
    expect(retryOnFailure).toHaveBeenCalledExactlyOnceWith({ exitCode: 6, stderr: 'abcd' });
    expect(manager.readOutput(launched.id)?.stderr).toBe('def');
  });

  it('does not request retry after success, spawn error, or kill', async () => {
    const retryOnFailure = vi.fn(async () => null);
    const success = manager.launch('exit 0', { retryOnFailure });
    const killed = manager.launch('sleep 30', { retryOnFailure });
    manager.kill(killed.id);
    const invalidCwd = new BackgroundProcessManager({ cwd: join(root, 'missing') });
    const spawnError = invalidCwd.launch('exit 3', { retryOnFailure });
    await until(
      () =>
        manager.get(success.id)?.status === 'exited' &&
        manager.get(killed.id)?.status === 'killed' &&
        invalidCwd.get(spawnError.id)?.status === 'exited',
    );
    expect(invalidCwd.readOutput(spawnError.id)?.stderr).toMatch(/ENOENT/);
    expect(retryOnFailure).not.toHaveBeenCalled();
  });
});
