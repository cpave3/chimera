import { type ChildProcess, spawn } from 'node:child_process';

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SIGKILL_DELAY_MS = 2_000;

export type BackgroundProcessStatus = 'running' | 'exited' | 'killed';

export interface SandboxRetry {
  reason: string;
  initialExitCode: number;
}

export interface BackgroundLaunchOptions {
  env?: Record<string, string>;
  shellCommand?: string;
  retryOnFailure?: (result: { exitCode: number; stderr: string }) => Promise<{
    shellCommand: string;
    reason: string;
  } | null>;
}

export interface BackgroundProcess {
  id: string;
  command: string;
  status: BackgroundProcessStatus;
  exitCode: number | null;
  startedAt: number;
  sandboxRetry?: SandboxRetry;
}

export interface BackgroundOutputRead {
  stdout: string;
  stderr: string;
  status: BackgroundProcessStatus;
  exitCode: number | null;
  truncated: boolean;
  sandboxRetry?: SandboxRetry;
}

export interface BackgroundExitNotice {
  shellId: string;
  command: string;
  status: BackgroundProcessStatus;
  exitCode: number | null;
}

export interface BackgroundProcessManagerOptions {
  cwd: string;
  maxOutputBytes?: number;
  /** Fired once per process when it leaves the `running` state. */
  onExit?: (notice: BackgroundExitNotice) => void;
}

interface TrackedProcess {
  record: BackgroundProcess;
  child: ChildProcess;
  stdout: CursorBuffer;
  stderr: CursorBuffer;
  authorizing: boolean;
  killRequested: boolean;
}

/**
 * Registry of long-running shell processes launched by the bash tool's
 * `run_in_background` flag. Host-only: background processes are spawned
 * directly rather than through an Executor, because `Executor.exec` resolves
 * only on completion. Output is buffered with a per-stream byte cap and read
 * destructively — each `readOutput` returns only what arrived since the
 * previous read.
 */
export class BackgroundProcessManager {
  private readonly cwd: string;
  private readonly maxOutputBytes: number;
  private readonly onExit: ((notice: BackgroundExitNotice) => void) | undefined;
  private readonly processes = new Map<string, TrackedProcess>();
  private nextId = 1;

  constructor(opts: BackgroundProcessManagerOptions) {
    this.cwd = opts.cwd;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.onExit = opts.onExit;
  }

  /**
   * Start `command` in the background. `shellCommand` is what runs when it
   * differs from what the record should show: the command in its sandbox.
   */
  launch(command: string, opts: BackgroundLaunchOptions = {}): BackgroundProcess {
    const id = `shell_${this.nextId++}`;
    const child = spawn('sh', ['-c', opts.shellCommand ?? command], {
      cwd: this.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const record: BackgroundProcess = {
      id,
      command,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
    };
    const tracked: TrackedProcess = {
      record,
      child,
      stdout: new CursorBuffer(this.maxOutputBytes),
      stderr: new CursorBuffer(this.maxOutputBytes),
      authorizing: false,
      killRequested: false,
    };
    this.watchAttempt(tracked, opts);
    this.processes.set(id, tracked);
    return { ...record };
  }

  private watchAttempt(tracked: TrackedProcess, opts: BackgroundLaunchOptions): void {
    const child = tracked.child;
    const attemptStderr = opts.retryOnFailure ? new CursorBuffer(this.maxOutputBytes) : undefined;
    child.stdout?.on('data', (chunk: Buffer) => tracked.stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      tracked.stderr.push(chunk);
      attemptStderr?.push(chunk);
    });
    child.on('error', (err) => {
      tracked.stderr.push(Buffer.from(String(err.message)));
      this.settle(tracked, 'exited', -1);
    });
    child.on('close', (code, signal) => {
      if (tracked.record.status !== 'running') return;
      const wasSignalled = signal === 'SIGTERM' || signal === 'SIGKILL';
      const exitCode = code ?? (wasSignalled ? -1 : 0);
      if (tracked.killRequested) {
        this.settle(tracked, 'killed', exitCode);
        return;
      }
      if (signal === null && exitCode !== 0 && opts.retryOnFailure) {
        void this.retry(tracked, opts, exitCode, attemptStderr!.consume());
      } else {
        this.settle(tracked, wasSignalled ? 'killed' : 'exited', exitCode);
      }
    });
  }

  private async retry(
    tracked: TrackedProcess,
    opts: BackgroundLaunchOptions,
    exitCode: number,
    stderr: string,
  ): Promise<void> {
    tracked.authorizing = true;
    try {
      const retry = await opts.retryOnFailure!({ exitCode, stderr });
      if (tracked.record.status !== 'running') return;
      tracked.authorizing = false;
      if (!retry) {
        this.settle(tracked, 'exited', exitCode);
        return;
      }
      tracked.record.sandboxRetry = { reason: retry.reason, initialExitCode: exitCode };
      tracked.stderr.pushNotice(`\nAutomatic host-retry: ${retry.reason}\n`);
      tracked.child = spawn('sh', ['-c', retry.shellCommand], {
        cwd: this.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      this.watchAttempt(tracked, { env: opts.env });
    } catch (err) {
      tracked.stderr.pushNotice(`\nAutomatic host-retry failed: ${String(err)}\n`);
      this.settle(tracked, 'exited', exitCode);
    }
  }

  get(id: string): BackgroundProcess | null {
    const tracked = this.processes.get(id);
    return tracked ? { ...tracked.record } : null;
  }

  list(): BackgroundProcess[] {
    return [...this.processes.values()].map((tracked) => ({ ...tracked.record }));
  }

  /** Consume and return output that arrived since the previous read. */
  readOutput(id: string): BackgroundOutputRead | null {
    const tracked = this.processes.get(id);
    if (!tracked) return null;
    return {
      stdout: tracked.stdout.consume(),
      stderr: tracked.stderr.consume(),
      status: tracked.record.status,
      exitCode: tracked.record.exitCode,
      truncated: tracked.stdout.truncated || tracked.stderr.truncated,
      ...(tracked.record.sandboxRetry ? { sandboxRetry: tracked.record.sandboxRetry } : {}),
    };
  }

  /** SIGTERM the process group, escalating to SIGKILL after a grace period. */
  kill(id: string): boolean {
    const tracked = this.processes.get(id);
    if (!tracked || tracked.record.status !== 'running') return false;
    tracked.killRequested = true;
    if (tracked.authorizing) {
      this.settle(tracked, 'killed', -1);
      return true;
    }
    this.signalGroup(tracked.child, 'SIGTERM');
    const killTimer = setTimeout(() => {
      if (tracked.record.status === 'running') {
        this.signalGroup(tracked.child, 'SIGKILL');
      }
    }, SIGKILL_DELAY_MS);
    killTimer.unref();
    return true;
  }

  killAll(): void {
    for (const tracked of this.processes.values()) {
      if (tracked.record.status === 'running') {
        tracked.killRequested = true;
        if (tracked.authorizing) this.settle(tracked, 'killed', -1);
        else this.signalGroup(tracked.child, 'SIGKILL');
      }
    }
  }

  private settle(tracked: TrackedProcess, status: BackgroundProcessStatus, exitCode: number): void {
    if (tracked.record.status !== 'running') return;
    tracked.record.status = status;
    tracked.record.exitCode = exitCode;
    this.onExit?.({
      shellId: tracked.record.id,
      command: tracked.record.command,
      status,
      exitCode,
    });
  }

  private signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      // Negative pid → signal the whole process group (the `sh -c` and any
      // children it spawned, e.g. a dev server behind a package script).
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Process already gone.
      }
    }
  }
}

/**
 * Byte-capped accumulator with a destructive read cursor. Chunks past the cap
 * are dropped and `truncated` flips to true.
 */
class CursorBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  // Lifecycle notices must remain visible even when process output hit the cap.
  pushNotice(text: string): void {
    const chunk = Buffer.from(text);
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

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

  consume(): string {
    const text = Buffer.concat(this.chunks, this.size).toString('utf8');
    this.chunks = [];
    this.size = 0;
    return text;
  }
}
