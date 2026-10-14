import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentEvent } from '@chimera/core';

export interface ChimeraRunOptions {
  /** The chimera invocation, for example `['node', '/repo/packages/cli/dist/bin.js']`. */
  command: string[];
  cwd: string;
  home: string;
  /** Flags after `run --json --max-steps <n>`. */
  flags: string[];
  prompt: string;
  maxSteps: number;
  timeoutMs: number;
}

export interface ChimeraRun {
  events: AgentEvent[];
  exitCode: number | null;
  /** Set when the harness ended the run: it ran too long, or it asked for a permission. */
  stopped?: 'timeout' | 'permission';
  /** The end of what the run wrote to stderr. */
  stderr: string;
  durationMs: number;
}

const STDERR_LIMIT = 4_000;
const KILL_GRACE_MS = 2_000;

// A run is the leader of its own process group, so Ctrl+C on the harness does
// not reach it. Stop the active runs when the harness is told to stop.
const activeRuns = new Set<number>();
let stopsRunsOnSignal = false;

function stopRunsOnSignal(): void {
  if (stopsRunsOnSignal) return;
  stopsRunsOnSignal = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      for (const pid of activeRuns) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // The group is gone already.
        }
      }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

export function runChimera(options: ChimeraRunOptions): Promise<ChimeraRun> {
  const [executable, ...baseArgs] = options.command;
  if (!executable) throw new Error('The chimera command is empty.');
  const args = [
    ...baseArgs,
    'run',
    '--json',
    '--max-steps',
    String(options.maxSteps),
    ...options.flags,
    options.prompt,
  ];

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // Its own process group, so a stop also reaches the commands and
    // subagents that the run started.
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, HOME: options.home },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    stopRunsOnSignal();
    if (child.pid !== undefined) activeRuns.add(child.pid);

    const events: AgentEvent[] = [];
    let stderr = '';
    let stopped: ChimeraRun['stopped'];
    let killTimer: NodeJS.Timeout | undefined;

    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is gone already.
      }
    };
    const stop = (reason: NonNullable<ChimeraRun['stopped']>) => {
      if (stopped) return;
      stopped = reason;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
    };
    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);

    createInterface({ input: child.stdout }).on('line', (line) => {
      let event: AgentEvent;
      try {
        event = JSON.parse(line) as AgentEvent;
      } catch {
        return;
      }
      events.push(event);
      // `chimera run` waits for an answer that no client will send.
      if (event.type === 'permission_request') stop('permission');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      reject(error);
    });
    // A command the run left in the background holds stdout open, and `close`
    // would wait for it.
    child.on('exit', () => signalGroup('SIGTERM'));
    child.on('close', (exitCode) => {
      if (child.pid !== undefined) activeRuns.delete(child.pid);
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolve({ events, exitCode, stopped, stderr, durationMs: Date.now() - startedAt });
    });
  });
}
