import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { authenticateSudo } from '../src/input/sudo-authentication';

function terminal() {
  const writes: string[] = [];
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
    stdout: {
      isTTY: true,
      write(value: string) {
        writes.push(value);
        return true;
      },
    } as unknown as NodeJS.WriteStream,
    writes,
  };
}

function childThatExits(code: number | null): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => true);
  queueMicrotask(() => child.emit('exit', code, null));
  return child;
}

describe('authenticateSudo', () => {
  it('shows an explicit hidden-input prompt and success before restoring the TUI', async () => {
    const spawn = vi.fn(() => childThatExits(0));
    const owner = terminal();

    await expect(
      authenticateSudo({ ...owner, spawn, effectiveUserId: () => 1000 }),
    ).resolves.toEqual({ status: 'validated' });
    expect(spawn).toHaveBeenCalledWith(
      'sudo',
      ['-v', '-p', 'Sudo password (input hidden — type it, then press Enter once): '],
      { stdio: 'inherit' },
    );
    expect(owner.writes.join('')).toContain(
      'Chimera has paused its input while sudo owns the terminal.',
    );
    expect(owner.writes.join('')).toContain('Input is hidden; no dots or characters will appear.');
    expect(owner.writes.join('')).toContain('Sudo authentication complete. Returning to Chimera.');
  });

  it('reports failure without exposing prompt contents', async () => {
    const spawn = vi.fn(() => childThatExits(1));
    const owner = terminal();

    await expect(
      authenticateSudo({ ...owner, spawn, effectiveUserId: () => 1000 }),
    ).resolves.toEqual({
      status: 'failed',
      message: 'sudo authentication failed with status 1; the command was not executed.',
    });
    expect(owner.writes.join('')).toContain('Sudo authentication failed. Returning to Chimera.');
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
    const owner = terminal();
    const authentication = authenticateSudo({
      ...owner,
      spawn: () => child,
      effectiveUserId: () => 1000,
      signal: controller.signal,
    });

    controller.abort();
    child.emit('exit', null, 'SIGTERM');

    await expect(authentication).resolves.toMatchObject({ status: 'cancelled' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(owner.writes.join('')).toContain('Sudo authentication cancelled. Returning to Chimera.');
  });
});
