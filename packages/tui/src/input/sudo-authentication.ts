import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import type { HostAuthenticationResult } from '@chimera/core';

type Spawn = typeof nodeSpawn;

export type SudoAuthenticationCheckResult =
  | { status: 'validated' }
  | { status: 'password_required' }
  | { status: 'unavailable'; message: string };

export interface CheckSudoAuthenticationOptions {
  signal?: AbortSignal;
  spawn?: Spawn;
  effectiveUserId?: () => number | undefined;
}

export interface AuthenticateSudoPasswordOptions {
  password: Uint8Array;
  signal?: AbortSignal;
  spawn?: Spawn;
}

export async function checkSudoAuthentication(
  options: CheckSudoAuthenticationOptions,
): Promise<SudoAuthenticationCheckResult> {
  if (options.effectiveUserId?.() === 0) return { status: 'validated' };

  try {
    const child = (options.spawn ?? nodeSpawn)('sudo', ['-n', '-v'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const result = await waitForValidation(child, options.signal);
    if (result.error) throw result.error;
    return result.code === 0 ? { status: 'validated' } : { status: 'password_required' };
  } catch (error) {
    return {
      status: 'unavailable',
      message: `sudo authentication is unavailable: ${(error as Error).message}`,
    };
  }
}

export async function authenticateSudoPassword(
  options: AuthenticateSudoPasswordOptions,
): Promise<HostAuthenticationResult> {
  const passwordInput = new Uint8Array(options.password.length + 1);
  passwordInput.set(options.password);
  passwordInput[passwordInput.length - 1] = 0x0a;
  options.password.fill(0);

  try {
    const child = (options.spawn ?? nodeSpawn)('sudo', ['-S', '-p', '', '-v'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const inputWritten = writePassword(child, passwordInput);
    const result = await waitForValidation(child, options.signal);
    await inputWritten;
    if (result.error) throw result.error;
    if (result.cancelled) {
      return {
        status: 'cancelled',
        message: 'sudo authentication was cancelled; the command was not executed.',
      };
    }
    if (result.code === 0) return { status: 'validated' };
    return {
      status: 'failed',
      message: 'sudo authentication failed; check the password and try again.',
    };
  } catch (error) {
    return {
      status: 'unavailable',
      message: `sudo authentication is unavailable: ${(error as Error).message}`,
    };
  } finally {
    options.password.fill(0);
    passwordInput.fill(0);
  }
}

function writePassword(child: ChildProcess, passwordInput: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.stdin) {
      reject(new Error('sudo password input is unavailable'));
      return;
    }
    child.stdin.once('error', reject);
    child.stdin.end(passwordInput, () => {
      child.stdin?.removeListener('error', reject);
      passwordInput.fill(0);
      resolve();
    });
  });
}

async function waitForValidation(
  child: ChildProcess,
  signal: AbortSignal | undefined,
): Promise<{ code: number | null; cancelled: boolean; error?: Error }> {
  return new Promise((resolve) => {
    let cancelled = signal?.aborted ?? false;
    let settled = false;
    let cancellationTimer: NodeJS.Timeout | undefined;
    const finish = (result: { code: number | null; cancelled: boolean; error?: Error }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (cancellationTimer) clearTimeout(cancellationTimer);
      resolve(result);
    };
    const abort = () => {
      cancelled = true;
      child.kill('SIGTERM');
      cancellationTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ code: null, cancelled: true });
      }, 1_000);
      cancellationTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => finish({ code: null, cancelled, error }));
    child.once('exit', (code) => finish({ code, cancelled }));
    if (cancelled) abort();
  });
}
