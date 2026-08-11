import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { authenticateSudo } from '../src/input/sudo-authentication';

function terminal() {
  return {
    stdin: {
      isTTY: true,
      isRaw: true,
      setRawMode(value: boolean) {
        this.isRaw = value;
      },
      pause() {},
      resume() {},
      read() {
        return null;
      },
    } as unknown as NodeJS.ReadStream,
    stdout: { isTTY: true, write: () => true } as unknown as NodeJS.WriteStream,
  };
}

function childThatExits(code: number | null): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => true);
  queueMicrotask(() => child.emit('exit', code, null));
  return child;
}

describe('authenticateSudo', () => {
  it('runs sudo -v with inherited terminal stdio', async () => {
    const spawn = vi.fn(() => childThatExits(0));

    await expect(
      authenticateSudo({ ...terminal(), spawn, effectiveUserId: () => 1000 }),
    ).resolves.toEqual({ status: 'validated' });
    expect(spawn).toHaveBeenCalledWith('sudo', ['-v'], { stdio: 'inherit' });
  });

  it('reports failure without exposing prompt contents', async () => {
    const spawn = vi.fn(() => childThatExits(1));

    await expect(
      authenticateSudo({ ...terminal(), spawn, effectiveUserId: () => 1000 }),
    ).resolves.toEqual({
      status: 'failed',
      message: 'sudo authentication failed with status 1; the command was not executed.',
    });
  });

  it('reports a missing sudo executable as unavailable', async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as ChildProcess;
      child.kill = vi.fn(() => true);
      queueMicrotask(() => child.emit('error', new Error('spawn sudo ENOENT')));
      return child;
    });

    await expect(
      authenticateSudo({ ...terminal(), spawn, effectiveUserId: () => 1000 }),
    ).resolves.toEqual({
      status: 'unavailable',
      message: 'sudo authentication is unavailable: spawn sudo ENOENT',
    });
  });

  it('skips OS authentication when Chimera already runs as root', async () => {
    const spawn = vi.fn();

    await expect(
      authenticateSudo({ ...terminal(), spawn, effectiveUserId: () => 0 }),
    ).resolves.toEqual({ status: 'validated' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cancels sudo validation when the request aborts', async () => {
    const child = new EventEmitter() as ChildProcess;
    child.kill = vi.fn(() => true);
    const controller = new AbortController();
    const authentication = authenticateSudo({
      ...terminal(),
      spawn: () => child,
      effectiveUserId: () => 1000,
      signal: controller.signal,
    });

    controller.abort();
    child.emit('exit', null, 'SIGTERM');

    await expect(authentication).resolves.toMatchObject({ status: 'cancelled' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
