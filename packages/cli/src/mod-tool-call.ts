import type { ModHost } from '@chimera/mods';
import type { ToolMiddleware } from '@chimera/tools';

export function modToolMiddleware(host: ModHost, sessionId: string): ToolMiddleware {
  return async (call, next) => {
    const result = await host.intercept('tool.call', {
      type: 'tool.call', sessionId, toolName: call.name, args: call.args,
    }, () => next());
    if (result && typeof result === 'object' && 'decision' in result && result.decision === 'block') {
      throw new Error(`Blocked by mod: ${'reason' in result ? result.reason : call.name}`);
    }
    return result;
  };
}
