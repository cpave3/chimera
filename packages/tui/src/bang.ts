import { exec, type ExecOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const BANG_TIMEOUT_MS = 30_000;
const BANG_MAX_BUFFER = 1024 * 1024; // 1 MiB

export interface BangResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  killedByBuffer: boolean;
}

export async function runBangCommand(command: string, cwd: string): Promise<BangResult> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), BANG_TIMEOUT_MS);

  try {
    const execOptions: ExecOptions = {
      cwd,
      encoding: 'utf-8',
      maxBuffer: BANG_MAX_BUFFER,
      signal: abortController.signal,
    };
    const { stdout, stderr } = await execAsync(command, execOptions);
    return {
      stdout: (stdout as string) ?? '',
      stderr: (stderr as string) ?? '',
      exitCode: 0,
      timedOut: false,
      killedByBuffer: false,
    };
  } catch (err) {
    const execErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | null;
    };
    const killedByBuffer = execErr.code === 'ENOBUFS';
    if (execErr.name === 'AbortError') {
      return {
        stdout: execErr.stdout ?? '',
        stderr: execErr.stderr ?? '',
        exitCode: typeof execErr.code === 'number' ? execErr.code : -1,
        timedOut: true,
        killedByBuffer: false,
      };
    }
    return {
      stdout: execErr.stdout ?? '',
      stderr: killedByBuffer
        ? `${execErr.stderr ?? ''}\n(truncated: output exceeded ${BANG_MAX_BUFFER} byte limit)`.trim()
        : (execErr.stderr ?? ''),
      exitCode: typeof execErr.code === 'number' ? execErr.code : 1,
      timedOut: false,
      killedByBuffer,
    };
  } finally {
    clearTimeout(timer);
  }
}
