import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import type { HostAuthenticationResult } from '@chimera/core';
import { type TerminalOwner, withTerminalHandoff } from './terminal-handoff';

type Spawn = typeof nodeSpawn;

const SUDO_PROMPT = 'Sudo password (input hidden — type it, then press Enter once): ';
const AUTHENTICATION_BANNER =
  '\r\n--- Sudo authentication ---\r\n' +
  'Chimera has paused its input while sudo owns the terminal.\r\n' +
  'Input is hidden; no dots or characters will appear. Type your password, then press Enter once.\r\n' +
  'Press Ctrl+C to cancel.\r\n\r\n';

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
      options.stdout.write(AUTHENTICATION_BANNER);
      const child = (options.spawn ?? nodeSpawn)('sudo', ['-v', '-p', SUDO_PROMPT], {
        stdio: 'inherit',
      });
      const result = await waitForValidation(child, options.signal);
      if (result.error) throw result.error;
      if (result.cancelled) {
        options.stdout.write('\r\nSudo authentication cancelled. Returning to Chimera.\r\n');
        return {
          status: 'cancelled',
          message: 'sudo authentication was cancelled; the command was not executed.',
        };
      }
      if (result.code === 0) {
        options.stdout.write('\r\nSudo authentication complete. Returning to Chimera.\r\n');
        return { status: 'validated' };
      }
      options.stdout.write('\r\nSudo authentication failed. Returning to Chimera.\r\n');
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
