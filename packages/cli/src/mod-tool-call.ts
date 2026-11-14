import type { ModHost } from '@chimera/mods';
import type { ToolMiddleware } from '@chimera/tools';

/** The event stays mutable across next(), so each mod sees the preceding rewrite. */
export function modToolMiddleware(host: ModHost, sessionId: string): ToolMiddleware {
  return async (call, next) => {
    const event = {
      type: 'tool.call',
      sessionId,
      toolName: call.name,
      args: call.args,
      additionalContext: undefined as string | undefined,
    };
    const result = await host.intercept('tool.call', event, () =>
      next({ name: call.name, args: event.args }),
    );
    if (
      result &&
      typeof result === 'object' &&
      'decision' in result &&
      result.decision === 'block'
    ) {
      throw new Error(`Blocked by mod: ${'reason' in result ? result.reason : call.name}`);
    }
    return event.additionalContext
      ? { result, additionalContext: event.additionalContext }
      : result;
  };
}
