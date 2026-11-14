import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

export interface ProcessOptions {
  argv: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ProcessHandle {
  write(text: string): Promise<void>;
  close(): void;
  kill(signal?: NodeJS.Signals): void;
  output: AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>;
  exitPromise: Promise<{ code: number | null; signal: string | null }>;
}

export class ModProcesses {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();

  spawn({ argv, env, cwd }: ProcessOptions): ProcessHandle {
    if (!argv.length) throw new Error('process.spawn requires a nonempty argv');
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env },
      cwd,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    });
    this.children.add(child);
    const chunks: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: Error | undefined;
    let inputFailure: Error | undefined;
    child.stdin.on('error', (error) => {
      inputFailure = error;
    });
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].setEncoding('utf8');
      child[stream].on('data', (text: string) => {
        chunks.push({ stream, text });
        wake?.();
      });
    }
    const exitPromise = new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once('error', (error) => {
          failure = error;
          reject(error);
        });
        child.once('close', (code, signal) => {
          this.children.delete(child);
          done = true;
          wake?.();
          resolve({ code, signal });
        });
      },
    );
    // Consumers may read output before awaiting the exit promise.
    void exitPromise.catch(() => undefined);
    return {
      write: (text) =>
        new Promise<void>((resolve, reject) => {
          if (inputFailure) {
            reject(inputFailure);
            return;
          }
          child.stdin.write(text, (error) => (error ? reject(error) : resolve()));
        }),
      close: () => {
        child.stdin.end();
      },
      kill: (signal = 'SIGTERM') => {
        this.signal(child, signal);
      },
      output: {
        async *[Symbol.asyncIterator]() {
          while (!done || chunks.length) {
            if (chunks.length) yield chunks.shift()!;
            else
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
          if (failure) throw failure;
        },
      },
      exitPromise,
    };
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            const finish = (error?: unknown) => {
              clearTimeout(escalation);
              clearTimeout(deadline);
              child.off('close', onClose);
              this.children.delete(child);
              if (error) reject(error);
              else resolve();
            };
            const onClose = () => finish();
            const escalation = setTimeout(() => {
              try {
                this.signal(child, 'SIGKILL');
              } catch (error) {
                finish(error);
              }
            }, 2_000);
            const deadline = setTimeout(() => {
              child.stdin.destroy();
              child.stdout.destroy();
              child.stderr.destroy();
              finish();
            }, 3_000);
            child.once('close', onClose);
            try {
              this.signal(child, 'SIGTERM');
            } catch (error) {
              finish(error);
            }
          }),
      ),
    );
  }

  private signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (process.platform === 'win32' || !child.pid) {
      child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}
