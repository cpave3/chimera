import { type ChildProcess, spawn } from 'node:child_process';

export interface StatusLineCommandOptions {
  /** Run with `sh -c`, as Claude Code runs its status line command. */
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Events closer together than this run the command once. */
  debounceMs?: number;
  /** A run that takes longer is killed; the last good output stays. */
  timeoutMs?: number;
  /** Called with every line of a run that exited 0. */
  onOutput(lines: string[]): void;
}

export const STATUS_COMMAND_DEBOUNCE_MS = 300;
export const STATUS_COMMAND_TIMEOUT_MS = 2_000;

/**
 * Runs the user's status line command on session events. Events are
 * debounced, a new one cancels the run in flight, and a run that fails or
 * takes too long leaves the last good output in place, so a slow or broken
 * script never holds up the TUI.
 */
export class StatusLineCommand {
  /** The last good output, one string per line. */
  lines: string[] = [];
  /** Why the last run gave no output; cleared by a good one. */
  lastError: string | null = null;

  private timer: NodeJS.Timeout | undefined;
  private child: ChildProcess | null = null;
  private disposed = false;

  constructor(private readonly options: StatusLineCommandOptions) {}

  update(payload: unknown, columns: number): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.cancel();
    this.timer = setTimeout(
      () => this.run(payload, columns),
      this.options.debounceMs ?? STATUS_COMMAND_DEBOUNCE_MS,
    );
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.cancel();
  }

  private cancel(): void {
    if (!this.child) return;
    const { pid } = this.child;
    this.child.removeAllListeners();
    try {
      // The whole group: `sh -c` does not always pass a signal on to the script.
      if (pid !== undefined) process.kill(-pid, 'SIGKILL');
    } catch {
      this.child.kill('SIGKILL');
    }
    this.child = null;
  }

  private run(payload: unknown, columns: number): void {
    const child = spawn('sh', ['-c', this.options.command], {
      cwd: this.options.cwd,
      env: { ...(this.options.env ?? process.env), COLUMNS: String(columns) },
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: true,
    });
    this.child = child;
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const timeout = setTimeout(() => {
      if (this.child !== child) return;
      this.cancel();
      this.lastError = `status line command timed out after ${this.options.timeoutMs ?? STATUS_COMMAND_TIMEOUT_MS}ms`;
    }, this.options.timeoutMs ?? STATUS_COMMAND_TIMEOUT_MS);
    timeout.unref?.();
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (this.child !== child) return;
      this.child = null;
      this.lastError = error.message;
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (this.child !== child) return;
      this.child = null;
      if (code !== 0) {
        this.lastError = `status line command failed (exit ${code})`;
        return;
      }
      this.lastError = null;
      this.lines = stdout.replace(/\n+$/, '').split('\n');
      this.options.onOutput(this.lines);
    });
    child.stdin?.on('error', () => {
      // A script that exits without reading its input closes the pipe early.
    });
    child.stdin?.end(JSON.stringify(payload));
  }
}
