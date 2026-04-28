import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChimeraClient } from '@chimera/client';
import type { AgentEvent, SessionId } from '@chimera/core';
import type { AutoApproveLevel } from '@chimera/permissions';
import { HandshakeError, readHandshakeLine } from './handshake';

const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3_000;
const SIGTERM_GRACE_MS = 2_000;
const INTERRUPT_GRACE_MS = 5_000;

export interface SpawnChildArgs {
  /** The executable to spawn (e.g. `/usr/local/bin/chimera` or `node`). */
  chimeraBin: string;
  /** Args to prepend before the chimera subcommand (e.g. `[bin.js]` when chimeraBin is `node`). */
  chimeraBinArgs?: string[];
  cwd: string;
  parentSessionId: SessionId;
  modelRef?: string;
  autoApprove: AutoApproveLevel;
  sandbox: boolean;
  sandboxMode?: 'bind' | 'overlay' | 'ephemeral';
  parentHasTty: boolean;
  currentSubagentDepth?: number;
  maxSubagentDepth?: number;
  /**
   * When set, the child reads this string verbatim as its system prompt
   * (passed via a temp file as `--system-prompt-file`, cleaned up at
   * teardown).
   */
  systemPrompt?: string;
  /** When set, restricts the child's registered tools to this allowlist. */
  tools?: string[];
}

export interface ChildHandle {
  proc: ChildProcess;
  client: ChimeraClient;
  url: string;
  childSessionId: SessionId;
  pid: number;
  /**
   * Temp directory holding the `--system-prompt-file` for this child, if any.
   * `teardownChild` removes it on cleanup.
   */
  promptDir?: string;
}

export function buildChildArgv(
  args: SpawnChildArgs,
  extras?: { systemPromptFile?: string },
): string[] {
  const argv: string[] = [
    ...(args.chimeraBinArgs ?? []),
    'serve',
    '--machine-handshake',
    '--cwd',
    args.cwd,
    '--auto-approve',
    args.autoApprove,
    '--parent',
    args.parentSessionId,
  ];
  if (args.modelRef) {
    argv.push('--model', args.modelRef);
  }
  if (args.sandbox) {
    argv.push('--sandbox');
    if (args.sandboxMode) {
      argv.push('--sandbox-mode', args.sandboxMode);
    }
  }
  if (!args.parentHasTty) {
    argv.push('--headless-permission-auto-deny');
  }
  if (typeof args.currentSubagentDepth === 'number') {
    argv.push('--current-subagent-depth', String(args.currentSubagentDepth));
  }
  if (typeof args.maxSubagentDepth === 'number') {
    argv.push('--max-subagent-depth', String(args.maxSubagentDepth));
  }
  if (extras?.systemPromptFile) {
    argv.push('--system-prompt-file', extras.systemPromptFile);
  }
  if (args.tools && args.tools.length > 0) {
    argv.push('--tools', args.tools.join(','));
  }
  return argv;
}

export async function spawnChimeraChild(args: SpawnChildArgs): Promise<ChildHandle> {
  let promptDir: string | undefined;
  let systemPromptFile: string | undefined;
  if (args.systemPrompt !== undefined) {
    promptDir = mkdtempSync(join(tmpdir(), 'chimera-subagent-'));
    systemPromptFile = join(promptDir, 'system-prompt.txt');
    writeFileSync(systemPromptFile, args.systemPrompt, 'utf8');
  }

  const argv = buildChildArgv(args, { systemPromptFile });
  const proc = spawn(args.chimeraBin, argv, {
    cwd: args.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    detached: false,
  });

  if (!proc.stdout || !proc.stderr) {
    throw new Error('child process missing stdio pipes');
  }

  // Buffer stderr for diagnostic on early failure.
  let stderrBuf = '';
  proc.stderr.on('data', (d: Buffer) => {
    stderrBuf += d.toString('utf8');
    if (stderrBuf.length > 4096) {
      stderrBuf = stderrBuf.slice(-4096);
    }
  });

  type EarlyExit = { code: number | null; signal: NodeJS.Signals | null };
  let earlyExit: EarlyExit | null = null;
  const exitHandler = (code: number | null, signal: NodeJS.Signals | null) => {
    earlyExit = { code, signal };
  };
  proc.once('exit', exitHandler);

  let handshake;
  try {
    handshake = await readHandshakeLine(proc.stdout, HANDSHAKE_TIMEOUT_MS);
  } catch (err) {
    proc.off('exit', exitHandler);
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    if (promptDir) {
      try {
        rmSync(promptDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    const observed = earlyExit as EarlyExit | null;
    const exitCtx = observed
      ? ` (child exit code=${observed.code ?? 'null'} signal=${observed.signal ?? 'null'})`
      : '';
    const stderrCtx = stderrBuf ? ` stderr: ${stderrBuf.slice(0, 500).trim()}` : '';
    if (err instanceof HandshakeError) {
      throw new HandshakeError(`${err.message}${exitCtx}.${stderrCtx}`, err.diagnostic);
    }
    throw err;
  }

  proc.off('exit', exitHandler);

  // Stop reading stdout further — child should not write more there.
  proc.stdout.removeAllListeners('data');

  const client = new ChimeraClient({ baseUrl: handshake.url });
  const ok = await waitForHealth(client, HEALTH_TIMEOUT_MS);
  if (!ok) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
    }
    throw new Error(`child server at ${handshake.url} failed /healthz check`);
  }

  return {
    proc,
    client,
    url: handshake.url,
    childSessionId: handshake.sessionId,
    pid: handshake.pid,
    promptDir,
  };
}

async function waitForHealth(client: ChimeraClient, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // No health method on ChimeraClient; getInstance() exercises the same path.
      await client.getInstance();
      return true;
    } catch {
      await delay(50);
    }
  }
  return false;
}

/**
 * Drive a child's run from start to finish, forwarding events. Returns the
 * collected result.
 */
export interface DriveChildResult {
  finalText: string;
  reason: 'stop' | 'max_steps' | 'error' | 'interrupted' | 'timeout';
  errorMessage?: string;
  steps: number;
  toolCallsCount: number;
}

export async function driveChild(
  handle: ChildHandle,
  prompt: string,
  onChildEvent: (event: AgentEvent) => void,
  opts: { signal?: AbortSignal; timeoutMs?: number },
): Promise<DriveChildResult> {
  let finalText = '';
  let reason: DriveChildResult['reason'] = 'stop';
  let errorMessage: string | undefined;
  let steps = 0;
  let toolCallsCount = 0;
  let timedOut = false;

  const sendController = new AbortController();
  const onParentAbort = () => sendController.abort();
  if (opts.signal) {
    if (opts.signal.aborted) sendController.abort();
    else opts.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      sendController.abort();
    }, opts.timeoutMs);
  }

  try {
    for await (const ev of handle.client.send(handle.childSessionId, prompt, {
      signal: sendController.signal,
    })) {
      // Re-emit verbatim through caller. (Caller wraps as subagent_event.)
      onChildEvent(ev as AgentEvent);

      if (ev.type === 'assistant_text_done') {
        finalText = ev.text;
      } else if (ev.type === 'tool_call_start') {
        toolCallsCount += 1;
      } else if (ev.type === 'step_finished') {
        steps += 1;
      } else if (ev.type === 'run_finished') {
        if (ev.reason === 'stop') reason = 'stop';
        else if (ev.reason === 'max_steps') reason = 'max_steps';
        else if (ev.reason === 'interrupted') reason = 'interrupted';
        else {
          reason = 'error';
          errorMessage = ev.error;
        }
      }
    }
  } catch (err) {
    if (timedOut) {
      reason = 'timeout';
    } else if (sendController.signal.aborted) {
      reason = 'interrupted';
    } else {
      reason = 'error';
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (opts.signal) opts.signal.removeEventListener('abort', onParentAbort);
  }

  // Override with `timeout` when the per-call timer fired, even if the child
  // surfaced its own clean run_finished afterwards.
  if (timedOut) reason = 'timeout';

  return { finalText, reason, errorMessage, steps, toolCallsCount };
}

/**
 * Final teardown: ask the child to delete its session, then signal the
 * process. Invoke after `driveChild` resolves regardless of outcome.
 */
export async function teardownChild(handle: ChildHandle): Promise<void> {
  // Best-effort delete the session via HTTP — the server may already be
  // shutting down due to interrupt, so swallow errors here.
  try {
    await handle.client.deleteSession(handle.childSessionId);
  } catch {
    // ignore
  }

  if (handle.proc.exitCode === null && handle.proc.signalCode === null) {
    await terminateProc(handle.proc, SIGTERM_GRACE_MS);
  }

  if (handle.promptDir) {
    try {
      rmSync(handle.promptDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Best-effort interrupt cascade: ask the server to interrupt the run, give
 * it up to INTERRUPT_GRACE_MS to surface `run_finished`, then SIGTERM.
 */
export async function interruptChild(handle: ChildHandle): Promise<void> {
  try {
    await handle.client.interrupt(handle.childSessionId);
  } catch {
    // server may already be down; fall through
  }
}

async function terminateProc(proc: ChildProcess, graceMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let resolved = false;
    const onExit = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    proc.once('exit', onExit);
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (resolved) return;
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      // Don't wait forever on SIGKILL either.
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        proc.off('exit', onExit);
        resolve();
      }, graceMs);
    }, graceMs);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const constants = {
  HANDSHAKE_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  SIGTERM_GRACE_MS,
  INTERRUPT_GRACE_MS,
};
