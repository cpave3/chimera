import type { LifecycleDecision, LifecycleHookData } from '@chimera/core';
import type { ToolCallInterceptor } from '@chimera/tools';

/**
 * Fire the `PreToolUse` hook before each tool call. A hook that blocks
 * answers the call with its reason as the tool error; the tool, and with it
 * the permission gate, never runs. The hook sees the input and cannot change
 * it: what runs is what the model asked for.
 */
export function preToolUseHook(
  dispatch: (
    payload: Extract<LifecycleHookData, { type: 'PreToolUse' }>,
  ) => Promise<LifecycleDecision>,
): ToolCallInterceptor {
  return {
    async before(call) {
      const toolInput =
        typeof call.args === 'object' && call.args !== null && !Array.isArray(call.args)
          ? (call.args as Record<string, unknown>)
          : { value: call.args };
      const result = await dispatch({
        type: 'PreToolUse',
        tool_name: call.name,
        tool_input: toolInput,
      });
      if (!result.blocked) return undefined;
      return {
        error: new Error(`blocked by PreToolUse hook: ${result.reason ?? 'no reason given'}`),
      };
    },
  };
}
