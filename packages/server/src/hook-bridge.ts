import type { LifecycleHookData, LifecycleSource } from '@chimera/core';
import { ALL_HOOK_EVENTS, type FirePayload, type HookRunner } from '@chimera/hooks';

/** The source orders these awaited scripts without making observational events block the agent. */
export function bridgeHooksToLifecycle(
  source: LifecycleSource,
  sessionId: string,
  runner: HookRunner,
): () => void {
  const inFlight = new Map<string, { name: string; args: unknown }>();

  return source.subscribe(async (env) => {
    if (env.sessionId !== sessionId) return;
    let payload: FirePayload;
    switch (env.type) {
      case 'user_message':
        payload = {
          event: 'UserPromptSubmit',
          user_message: env.content,
          source: env.source ?? 'user',
        };
        break;
      case 'tool_call_start':
        inFlight.set(env.callId, { name: env.name, args: env.args });
        return;
      case 'tool_call_result': {
        const meta = inFlight.get(env.callId);
        inFlight.delete(env.callId);
        payload = {
          event: 'PostToolUse',
          tool_name: meta?.name ?? 'unknown',
          tool_input: toRecord(meta?.args),
          tool_result: env.result,
        };
        break;
      }
      case 'tool_call_error': {
        const meta = inFlight.get(env.callId);
        inFlight.delete(env.callId);
        payload = {
          event: 'PostToolUse',
          tool_name: meta?.name ?? 'unknown',
          tool_input: toRecord(meta?.args),
          tool_error: env.error,
        };
        break;
      }
      case 'compaction_started':
        payload = { event: 'CompactionStart', reason: env.reason };
        break;
      case 'compaction_finished':
        payload = { event: 'CompactionEnd', success: true };
        break;
      case 'compaction_failed':
        payload = { event: 'CompactionEnd', success: false, error: env.error };
        break;
      default: {
        if (!(ALL_HOOK_EVENTS as readonly string[]).includes(env.type)) return;
        const {
          type,
          sessionId: _sessionId,
          cwd: _cwd,
          ...data
        } = env as LifecycleHookData & {
          sessionId: string;
          cwd: string;
        };
        payload = { event: type, ...data } as FirePayload;
      }
    }
    const result = await runner.fire(payload);
    return {
      blocked: result.blocked,
      reason: result.reason,
      additionalContext: result.parsedDecision?.additionalContext,
    };
  });
}

function toRecord(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}
