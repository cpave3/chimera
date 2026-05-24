import { spawn } from 'node:child_process';
import { discover, type DiscoveryOptions } from './discovery';
import {
  PRE_HOOK_EVENTS,
  type FirePayload,
  type HookDecision,
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
    let lastParsedDecision: HookDecision | undefined;
    for (const script of scripts) {
      const outcome = await this.runOne(script, json, env);

      if (outcome.exitCode === 0 && outcome.decision) {
        lastParsedDecision = outcome.decision;
        if (!blockResult && outcome.decision.decision === 'block') {
          blockResult = {
            blocked: true,
            blockingScript: script,
            reason: outcome.decision.reason || `blocked by hook: ${script}`,
            parsedDecision: outcome.decision,
          };
        }
      }

      if (!blockResult && isPre && outcome.exitCode === BLOCK_EXIT_CODE) {
        blockResult = {
          blocked: true,
          blockingScript: script,
          reason: outcome.stderr.trim() || `blocked by hook: ${script}`,
        };
        // Continue running remaining scripts per spec, but don't change outcome.
      }

      if (!outcome.ok && outcome.exitCode !== 0) {
        this.log('warn', `hook ${event} failed`, {
          script,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          stderr: outcome.stderr.trim().slice(0, 500),
        });
      }
    }

    if (blockResult) {
      return blockResult;
    }
    return lastParsedDecision
      ? { blocked: false, parsedDecision: lastParsedDecision }
      : { blocked: false };
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
      let stdout = '';
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
        settle({ ok: false, exitCode: null, timedOut: false, stderr: '', decision: undefined });
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
        settle({ ok: false, exitCode: null, timedOut, stderr, decision: undefined });
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          this.log('warn', `hook timed out`, { script, timeoutMs: this.timeoutMs });
          settle({ ok: false, exitCode: null, timedOut: true, stderr, decision: undefined });
          return;
        }
        if (code === 0) {
          const decision = tryParseDecision(stdout);
          settle({ ok: true, exitCode: 0, timedOut: false, stderr, decision });
          return;
        }
        if (code === null && signal) {
          settle({ ok: false, exitCode: null, timedOut: false, stderr, decision: undefined });
          return;
        }
        settle({ ok: false, exitCode: code, timedOut: false, stderr, decision: undefined });
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

const MAX_STRING_OUTPUT = 10_000;

interface RunOutcome {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  decision: HookDecision | undefined;
}

function tryParseDecision(stdout: string): HookDecision | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return undefined;

    // Merge hookSpecificOutput into top-level for convenience
    let merged = parsed;
    if (
      parsed.hookSpecificOutput &&
      typeof parsed.hookSpecificOutput === 'object' &&
      !Array.isArray(parsed.hookSpecificOutput)
    ) {
      merged = { ...(parsed.hookSpecificOutput as Record<string, unknown>), ...parsed };
    }

    const decision: HookDecision = {};

    if (merged.decision === 'block') {
      decision.decision = 'block';
    }

    const pickString = (key: string): string | undefined => {
      const value = merged[key];
      if (typeof value !== 'string') return undefined;
      return value.length > MAX_STRING_OUTPUT ? value.slice(0, MAX_STRING_OUTPUT) : value;
    };

    decision.reason = pickString('reason');
    decision.additionalContext = pickString('additionalContext');
    decision.systemMessage = pickString('systemMessage');

    if (merged.suppressOutput === true) {
      decision.suppressOutput = true;
    }

    if (merged.continue === false) {
      decision.continue = false;
    }

    if (parsed.hookSpecificOutput) {
      decision.hookSpecificOutput = parsed.hookSpecificOutput;
    }

    return decision;
  } catch {
    return undefined;
  }
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
