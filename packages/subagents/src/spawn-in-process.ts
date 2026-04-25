import type { AgentEvent, SessionId } from '@chimera/core';
import type { InProcessAgentBuilder } from './types';

export interface InProcessHandle {
  childSessionId: SessionId;
  send: (
    prompt: string,
    opts?: { signal?: AbortSignal },
  ) => AsyncIterable<AgentEvent>;
  interrupt: () => void;
  dispose: () => Promise<void>;
}

export async function spawnInProcessChild(args: {
  builder: InProcessAgentBuilder;
  cwd: string;
  modelRef: string;
  parsedModel: { providerId: string; modelId: string; maxSteps: number };
  sandboxMode: 'off' | 'bind' | 'overlay' | 'ephemeral';
  parentAbortSignal: AbortSignal;
  systemPrompt?: string;
  toolNames: string[];
  currentDepth: number;
  maxDepth: number;
}): Promise<InProcessHandle> {
  const built = await args.builder({
    cwd: args.cwd,
    model: args.parsedModel,
    sandboxMode: args.sandboxMode,
    parentAbortSignal: args.parentAbortSignal,
    systemPrompt: args.systemPrompt,
    toolNames: args.toolNames,
    currentDepth: args.currentDepth,
    maxDepth: args.maxDepth,
    // Always headless: the parent TUI cannot resolve a permission prompt
    // raised inside its own event loop. See SUBAGENTS.md.
    headlessAutoDeny: true,
  });
  return {
    childSessionId: built.sessionId,
    send: built.send,
    interrupt: built.interrupt,
    dispose: built.dispose,
  };
}

export interface DriveInProcessResult {
  finalText: string;
  reason: 'stop' | 'max_steps' | 'error' | 'interrupted' | 'timeout';
  errorMessage?: string;
  steps: number;
  toolCallsCount: number;
}

export async function driveInProcess(
  handle: InProcessHandle,
  prompt: string,
  onChildEvent: (event: AgentEvent) => void,
  opts: { signal?: AbortSignal; timeoutMs?: number },
): Promise<DriveInProcessResult> {
  let finalText = '';
  let reason: DriveInProcessResult['reason'] = 'stop';
  let errorMessage: string | undefined;
  let steps = 0;
  let toolCallsCount = 0;
  let timedOut = false;

  const sendController = new AbortController();
  const onParentAbort = () => {
    sendController.abort();
    handle.interrupt();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onParentAbort();
    else opts.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      sendController.abort();
      handle.interrupt();
    }, opts.timeoutMs);
  }

  try {
    for await (const ev of handle.send(prompt, { signal: sendController.signal })) {
      onChildEvent(ev);
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

  // If the child returned cleanly (no throw) but our timer / parent signal had
  // already fired, attribute the terminal reason to the timer / parent rather
  // than whatever the child reported. The timer is the load-bearing signal:
  // an interrupt from the timer must surface as `timeout`, not `interrupted`.
  if (timedOut) reason = 'timeout';

  return { finalText, reason, errorMessage, steps, toolCallsCount };
}
