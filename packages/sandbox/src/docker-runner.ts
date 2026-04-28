import { spawn } from 'node:child_process';

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface RunOptions {
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  encoding?: 'utf8' | 'buffer';
  /**
   * Per-stream byte cap. Once reached, further chunks are dropped and the
   * matching `stdoutTruncated`/`stderrTruncated` flag is set. Guards against
   * V8's ~512MB string-length limit when subprocesses dump huge output.
   * Defaults to 16 MiB.
   */
  maxOutputBytes?: number;
}

export interface RunRawResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface DockerRunner {
  run(args: string[], opts?: RunOptions): Promise<RunResult>;
  runRaw(args: string[], opts?: RunOptions): Promise<RunRawResult>;
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
      stdoutTruncated: runResult.stdoutTruncated,
      stderrTruncated: runResult.stderrTruncated,
    };
  }

  runRaw(args: string[], opts: RunOptions = {}): Promise<RunRawResult> {
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: opts.signal,
      });

      const stdoutBuffer = new BoundedBuffer(maxOutputBytes);
      const stderrBuffer = new BoundedBuffer(maxOutputBytes);
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      let settled = false;
      const settle = (result: RunRawResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

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

      child.stdout.on('data', (d: Buffer) => {
        try {
          stdoutBuffer.push(d);
        } catch (err) {
          fail(err);
        }
      });
      child.stderr.on('data', (d: Buffer) => {
        try {
          stderrBuffer.push(d);
        } catch (err) {
          fail(err);
        }
      });

      if (opts.stdin !== undefined) {
        child.stdin.write(opts.stdin);
      }
      child.stdin.end();

      child.on('error', (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        settle({
          stdout: stdoutBuffer.toBuffer(),
          stderr: stderrBuffer.toString() + String(err?.message ?? err),
          exitCode: -1,
          timedOut,
          stdoutTruncated: stdoutBuffer.truncated,
          stderrTruncated: stderrBuffer.truncated,
        });
      });

      child.on('close', (code, signal) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        const exitCode =
          code === null ? (signal === 'SIGTERM' || signal === 'SIGKILL' ? -1 : 0) : code;
        settle({
          stdout: stdoutBuffer.toBuffer(),
          stderr: stderrBuffer.toString(),
          exitCode,
          timedOut,
          stdoutTruncated: stdoutBuffer.truncated,
          stderrTruncated: stderrBuffer.truncated,
        });
      });
    });
  }
}

/**
 * Append-only Buffer accumulator with a hard byte cap. Once the cap is hit,
 * further chunks are dropped and `truncated` flips to true. Mirrors the
 * helper in `@chimera/tools/local-executor` to keep both exec paths from
 * crashing under massive subprocess output.
 */
class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    const remaining = this.cap - this.size;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return;
    }
    this.chunks.push(chunk.subarray(0, remaining));
    this.size += remaining;
    this.truncated = true;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }

  toString(): string {
    return this.toBuffer().toString('utf8');
  }
}
