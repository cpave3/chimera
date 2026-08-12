import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  authenticateSudoPassword,
  checkSudoAuthentication,
} from '../src/input/sudo-authentication';

function childThatExits(code: number | null): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => true);
  queueMicrotask(() => child.emit('exit', code, null));
  return child;
}

function childWithStdin(code: number | null): ChildProcess {
  const child = childThatExits(code);
  child.stdin = new PassThrough();
  return child;
}

describe('sudo authentication', () => {
  it('accepts cached credentials without requesting a password', async () => {
    const spawn = vi.fn(() => childThatExits(0));

    await expect(checkSudoAuthentication({ spawn, effectiveUserId: () => 1000 })).resolves.toEqual({
      status: 'validated',
    });
    expect(spawn).toHaveBeenCalledWith('sudo', ['-n', '-v'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  });

  it('requests masked input when cached credentials are unavailable', async () => {
    const spawn = vi.fn(() => childThatExits(1));

    await expect(checkSudoAuthentication({ spawn, effectiveUserId: () => 1000 })).resolves.toEqual({
      status: 'password_required',
    });
  });

  it('pipes password bytes to sudo without putting them in process metadata', async () => {
    const child = childWithStdin(0);
    const written: Buffer[] = [];
    child.stdin!.on('data', (chunk) => written.push(Buffer.from(chunk)));
    const spawn = vi.fn(() => child);
    const password = new TextEncoder().encode('hunter2');

    await expect(authenticateSudoPassword({ password, spawn })).resolves.toEqual({
      status: 'validated',
    });

    expect(spawn).toHaveBeenCalledWith('sudo', ['-S', '-p', '', '-v'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    expect(JSON.stringify(spawn.mock.calls[0])).not.toContain('hunter2');
    expect(Buffer.concat(written).toString()).toBe('hunter2\n');
    expect(password).toEqual(new Uint8Array(password.length));
  });

  it('reports a wrong password and clears its bytes', async () => {
    const password = new TextEncoder().encode('wrong');

    await expect(
      authenticateSudoPassword({ password, spawn: () => childWithStdin(1) }),
    ).resolves.toEqual({
      status: 'failed',
      message: 'sudo authentication failed; check the password and try again.',
    });
    expect(password).toEqual(new Uint8Array(password.length));
  });

  it('reports a missing sudo executable as unavailable', async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as ChildProcess;
      child.kill = vi.fn(() => true);
      queueMicrotask(() => child.emit('error', new Error('spawn sudo ENOENT')));
      return child;
    });

    await expect(checkSudoAuthentication({ spawn, effectiveUserId: () => 1000 })).resolves.toEqual({
      status: 'unavailable',
      message: 'sudo authentication is unavailable: spawn sudo ENOENT',
    });
  });

  it('skips OS authentication when Chimera already runs as root', async () => {
    const spawn = vi.fn();

    await expect(checkSudoAuthentication({ spawn, effectiveUserId: () => 0 })).resolves.toEqual({
      status: 'validated',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cancels password validation when the request aborts', async () => {
    const child = new EventEmitter() as ChildProcess;
    child.stdin = new PassThrough();
    child.kill = vi.fn(() => true);
    const controller = new AbortController();
    const password = new TextEncoder().encode('secret');
    const authentication = authenticateSudoPassword({
      password,
      spawn: () => child,
      signal: controller.signal,
    });

    controller.abort();
    child.emit('exit', null, 'SIGTERM');

    await expect(authentication).resolves.toMatchObject({ status: 'cancelled' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(password).toEqual(new Uint8Array(password.length));
  });
});
