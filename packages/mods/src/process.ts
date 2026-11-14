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
    });
    this.children.add(child);
    const chunks: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: Error | undefined;
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
          child.stdin.write(text, (error) => (error ? reject(error) : resolve()));
        }),
      close: () => {
        child.stdin.end();
      },
      kill: (signal = 'SIGTERM') => {
        child.kill(signal);
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
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
            child.once('close', () => {
              clearTimeout(timer);
              resolve();
            });
            child.kill('SIGTERM');
          }),
      ),
    );
  }
}
