import { spawn } from 'node:child_process';
import { discover, type DiscoveryOptions } from './discovery';
import {
  PRE_HOOK_EVENTS,
  type FirePayload,
  type HookEvent,
  type HookFireResult,
  type HookLogger,
  type HookPayload,
  type HookRunner,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const BLOCK_EXIT_CODE = 2;

export interface DefaultHookRunnerOptions {
  /** Session cwd. Used as both the spawn `cwd` and the project-hook root anchor. */
  cwd: string;
  /** Session ULID. Included in payload `session_id` and `CHIMERA_SESSION_ID`. */
  sessionId: string;
  /** Override the global root (used by tests). Defaults to ~/.chimera/hooks. */
  globalRoot?: string;
  /** Override the project root (used by tests). Defaults to <cwd>/.chimera/hooks. */
  projectRoot?: string;
  /** Per-script timeout in ms. Defaults to 30s. */
  timeoutMs?: number;
  /** Log warnings for non-zero exits, timeouts, exec failures. Defaults to console.warn. */
  log?: HookLogger;
}

export class DefaultHookRunner implements HookRunner {
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly discoveryOpts: DiscoveryOptions;
  private readonly timeoutMs: number;
  private readonly log: HookLogger;

  constructor(opts: DefaultHookRunnerOptions) {
    this.cwd = opts.cwd;
    this.sessionId = opts.sessionId;
    this.discoveryOpts = {
      globalRoot: opts.globalRoot,
      projectRoot: opts.projectRoot,
    };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log ?? defaultLog;
  }

  async fire(payload: FirePayload): Promise<HookFireResult> {
    const event = payload.event;
    const fullPayload = this.buildPayload(payload);
    const { global, project } = await discover(event, this.cwd, this.discoveryOpts);
    const scripts = [...global, ...project];
    if (scripts.length === 0) {
      return { blocked: false };
    }
    const isPre = PRE_HOOK_EVENTS.has(event);
    const json = JSON.stringify(fullPayload);
    const env = this.buildEnv(event);

    let blockResult: HookFireResult | undefined;
    for (const script of scripts) {
      const outcome = await this.runOne(script, json, env);
      if (isPre && outcome.exitCode === BLOCK_EXIT_CODE && !blockResult) {
        blockResult = {
          blocked: true,
          blockingScript: script,
          reason: outcome.stderr.trim() || `blocked by hook: ${script}`,
        };
        // Continue running remaining scripts per spec, but don't change outcome.
      } else if (!outcome.ok) {
        this.log('warn', `hook ${event} failed`, {
          script,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          stderr: outcome.stderr.trim().slice(0, 500),
        });
      }
    }
    return blockResult ?? { blocked: false };
  }

  private buildPayload(p: FirePayload): HookPayload {
    return {
      ...(p as object),
      event: p.event,
      session_id: this.sessionId,
      cwd: this.cwd,
    } as HookPayload;
  }

  private buildEnv(event: HookEvent): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CHIMERA_EVENT: event,
      CHIMERA_SESSION_ID: this.sessionId,
      CHIMERA_CWD: this.cwd,
    };
  }

  private runOne(script: string, json: string, env: NodeJS.ProcessEnv): Promise<RunOutcome> {
    return new Promise((resolve) => {
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const settle = (outcome: RunOutcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(script, [], {
          cwd: this.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          // Put the hook in its own process group so SIGKILL on timeout
          // takes down any grandchildren (e.g., a `sleep` inside the script).
          detached: true,
        });
      } catch (err) {
        this.log('warn', `hook spawn failed`, {
          script,
          error: (err as Error).message,
        });
        settle({ ok: false, exitCode: null, timedOut: false, stderr: '' });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        const pid = child.pid;
        if (pid !== undefined) {
          try {
            // Negative pid kills the whole process group.
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
        }
      }, this.timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        this.log('warn', `hook process error`, {
          script,
          error: err.message,
        });
        settle({ ok: false, exitCode: null, timedOut, stderr });
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      // Without a stdout consumer the pipe buffer fills, the script blocks
      // on its next write, and `close` never fires.
      child.stdout?.on('data', () => {});

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          this.log('warn', `hook timed out`, { script, timeoutMs: this.timeoutMs });
          settle({ ok: false, exitCode: null, timedOut: true, stderr });
          return;
        }
        if (code === 0) {
          settle({ ok: true, exitCode: 0, timedOut: false, stderr });
          return;
        }
        if (code === null && signal) {
          settle({ ok: false, exitCode: null, timedOut: false, stderr });
          return;
        }
        settle({ ok: false, exitCode: code, timedOut: false, stderr });
      });

      // Hooks may exit before we finish writing, which surfaces as EPIPE on
      // the stdin stream. We don't care — the close handler covers it — but
      // unhandled stream errors crash the process, so silence them here.
      child.stdin?.on('error', () => {});
      try {
        child.stdin?.write(json, (err) => {
          if (err) {
            child.stdin?.destroy();
          } else {
            child.stdin?.end();
          }
        });
      } catch {
        // If stdin closed early, the script may have already exited; let close handle it.
      }
    });
  }
}

interface RunOutcome {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
}

function defaultLog(level: 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
  const fn = level === 'error' ? console.error : console.warn;
  if (meta) {
    fn(`[hooks] ${msg}`, meta);
  } else {
    fn(`[hooks] ${msg}`);
  }
}

export class NoopHookRunner implements HookRunner {
  async fire(_payload: FirePayload): Promise<HookFireResult> {
    return { blocked: false };
  }
}
