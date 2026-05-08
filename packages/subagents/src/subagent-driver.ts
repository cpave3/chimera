import type { AgentEvent } from '@chimera/core';

export interface DriveResult {
  finalText: string;
  reason: 'stop' | 'max_steps' | 'error' | 'interrupted' | 'timeout';
  errorMessage?: string;
  steps: number;
  toolCallsCount: number;
}

export interface SubagentTransport {
  send(prompt: string, opts: { signal: AbortSignal }): AsyncIterable<AgentEvent>;
  interrupt(): void | Promise<void>;
}

/**
 * Shared event loop for driving a subagent to completion. Handles parent-signal
 * propagation, timeout, interrupt cascades, and event accumulation.
 */
export async function driveSubagent(
  transport: SubagentTransport,
  prompt: string,
  onEvent: (event: AgentEvent) => void,
  opts: { signal?: AbortSignal; timeoutMs?: number },
): Promise<DriveResult> {
  let finalText = '';
  let reason: DriveResult['reason'] = 'stop';
  let errorMessage: string | undefined;
  let steps = 0;
  let toolCallsCount = 0;
  let timedOut = false;

  const sendController = new AbortController();
  const onParentAbort = () => {
    sendController.abort();
    void transport.interrupt();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onParentAbort();
    else opts.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      onParentAbort();
    }, opts.timeoutMs);
  }

  try {
    for await (const ev of transport.send(prompt, { signal: sendController.signal })) {
      onEvent(ev);
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
    if (timedOut) reason = 'timeout';
    else if (sendController.signal.aborted) reason = 'interrupted';
    else {
      reason = 'error';
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (opts.signal) opts.signal.removeEventListener('abort', onParentAbort);
  }

  // If the child returned cleanly but our timer fired, attribute the terminal
  // reason to the timer so the caller sees timeout, not interrupted.
  if (timedOut) reason = 'timeout';

  return { finalText, reason, errorMessage, steps, toolCallsCount };
}
