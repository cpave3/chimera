import type { HookRunner } from '@chimera/hooks';
import type { EventBus } from './event-bus';

/**
 * Translate `AgentEvent`s on the bus into lifecycle-hook firings.
 *
 *  - `user_message`        → `UserPromptSubmit`
 *  - `tool_call_result`    → `PostToolUse` (success path)
 *  - `tool_call_error`     → `PostToolUse` (error path)
 *  - `compaction_started`  → `CompactionStart`
 *  - `compaction_finished` → `CompactionEnd` (success)
 *  - `compaction_failed`   → `CompactionEnd` (failure)
 *
 * `run_finished` is NOT translated here. The `Stop` hook is fired
 * synchronously inside `Agent.runInternal` so it can block the agent from
 * stopping. Bridging it here would fire the hook a second time, async.
 *
 * `tool_call_start` is consumed only to remember the tool's name + args so
 * the matching `tool_call_result` / `tool_call_error` event can be enriched
 * (those events carry only `callId`).
 *
 * Hook firings are intentionally **not awaited** — a slow hook must not block
 * the agent loop or the event bus. The runner enforces its own per-script
 * timeout.
 *
 * Returns the bus unsubscribe handle so callers can detach this bridge if
 * they ever need to. Today the bridge lives for the session's lifetime.
 */
export function bridgeHooksToBus(bus: EventBus, runner: HookRunner): () => void {
  const inFlight = new Map<string, { name: string; args: unknown }>();

  return bus.subscribe((env) => {
    switch (env.type) {
      case 'user_message':
        void runner.fire({ event: 'UserPromptSubmit', user_message: env.content });
        return;
      case 'tool_call_start':
        inFlight.set(env.callId, { name: env.name, args: env.args });
        return;
      case 'tool_call_result': {
        const meta = inFlight.get(env.callId);
        inFlight.delete(env.callId);
        void runner.fire({
          event: 'PostToolUse',
          tool_name: meta?.name ?? 'unknown',
          tool_input: toRecord(meta?.args),
          tool_result: env.result,
        });
        return;
      }
      case 'tool_call_error': {
        const meta = inFlight.get(env.callId);
        inFlight.delete(env.callId);
        void runner.fire({
          event: 'PostToolUse',
          tool_name: meta?.name ?? 'unknown',
          tool_input: toRecord(meta?.args),
          tool_error: env.error,
        });
        return;
      }
      case 'compaction_started':
        void runner.fire({ event: 'CompactionStart', reason: env.reason });
        return;
      case 'compaction_finished':
        void runner.fire({ event: 'CompactionEnd', success: true });
        return;
      case 'compaction_failed':
        void runner.fire({ event: 'CompactionEnd', success: false, error: env.error });
        return;
    }
  });
}

function toRecord(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}
