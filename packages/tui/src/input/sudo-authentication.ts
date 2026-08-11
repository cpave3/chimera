import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import type { HostAuthenticationResult } from '@chimera/core';
import { type TerminalOwner, withTerminalHandoff } from './terminal-handoff';

type Spawn = typeof nodeSpawn;

export interface AuthenticateSudoOptions extends TerminalOwner {
  signal?: AbortSignal;
  spawn?: Spawn;
  effectiveUserId?: () => number | undefined;
}

export async function authenticateSudo(
  options: AuthenticateSudoOptions,
): Promise<HostAuthenticationResult> {
  if (options.effectiveUserId?.() === 0) return { status: 'validated' };

  try {
    return await withTerminalHandoff(options, async () => {
      const child = (options.spawn ?? nodeSpawn)('sudo', ['-v'], { stdio: 'inherit' });
      const result = await waitForValidation(child, options.signal);
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
        message: `sudo authentication failed with status ${result.code ?? 'unknown'}; the command was not executed.`,
      };
    });
  } catch (error) {
    return {
      status: 'unavailable',
      message: `sudo authentication is unavailable: ${(error as Error).message}`,
    };
  }
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
