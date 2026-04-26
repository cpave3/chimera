import { spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface RunOptions {
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  encoding?: 'utf8' | 'buffer';
}

export interface DockerRunner {
  run(args: string[], opts?: RunOptions): Promise<RunResult>;
  runRaw(args: string[], opts?: RunOptions): Promise<{
    stdout: Buffer;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
  }>;
}

export interface SpawnDockerRunnerOptions {
  /**
   * Process to invoke. Defaults to `docker`. Tests inject `sh` so the
   * timeout / SIGTERM→SIGKILL progression can be exercised against a real
   * child without needing a Docker daemon.
   */
  command?: string;
}

export class SpawnDockerRunner implements DockerRunner {
  private readonly command: string;

  constructor(opts: SpawnDockerRunnerOptions = {}) {
    this.command = opts.command ?? 'docker';
  }

  async run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const runResult = await this.runRaw(args, opts);
    return {
      stdout: runResult.stdout.toString('utf8'),
      stderr: runResult.stderr,
      exitCode: runResult.exitCode,
      timedOut: runResult.timedOut,
    };
  }

  runRaw(args: string[], opts: RunOptions = {}): Promise<{
    stdout: Buffer;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
  }> {
    return new Promise((resolve) => {
      const child = spawn(this.command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: opts.signal,
      });

      const stdoutChunks: Buffer[] = [];
      let stderr = '';
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;

      const timeoutTimer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill('SIGTERM');
            } catch {}
            killTimer = setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch {}
            }, 2000);
          }, opts.timeoutMs)
        : null;

      child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });

      if (opts.stdin !== undefined) {
        child.stdin.write(opts.stdin);
      }
      child.stdin.end();

      child.on('error', (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve({
          stdout: Buffer.concat(stdoutChunks),
          stderr: stderr + String(err?.message ?? err),
          exitCode: -1,
          timedOut,
        });
      });

      child.on('close', (code, signal) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        const exitCode =
          code === null ? (signal === 'SIGTERM' || signal === 'SIGKILL' ? -1 : 0) : code;
        resolve({
          stdout: Buffer.concat(stdoutChunks),
          stderr,
          exitCode,
          timedOut,
        });
      });
    });
  }
}
