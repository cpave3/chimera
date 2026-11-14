import type { CommandPolicyAnalysis } from './command-policy';
import type { AgentEvent, PromptSource } from './events';

export type LifecycleHookData =
  | { type: 'SessionCreated'; session_name?: string }
  | { type: 'UserPromptSubmit'; user_message: string; source: PromptSource }
  | { type: 'PreToolUse'; tool_name: string; tool_input: Record<string, unknown> }
  | {
      type: 'PostToolUse';
      tool_name: string;
      tool_input: Record<string, unknown>;
      tool_result?: unknown;
      tool_error?: string;
    }
  | {
      type: 'PermissionRequest';
      tool_name: string;
      tool_input: Record<string, unknown>;
      target: string;
      command?: string;
      policy_analysis?: CommandPolicyAnalysis;
    }
  | {
      type: 'PermissionResolved';
      request_id: string;
      decision: 'allow' | 'deny';
      remembered: boolean;
      session_status: 'running' | 'waiting_for_permission';
      remaining_pending: number;
    }
  | { type: 'Stop'; reason: string }
  | { type: 'SessionEnd' }
  | { type: 'Timeout' }
  | { type: 'Interrupt' }
  | { type: 'OnError'; error: string }
  | {
      type: 'UserInputRequired';
      request: string;
      kind?: 'information' | 'action';
    }
  | { type: 'CompactionStart'; reason: string }
  | { type: 'CompactionEnd'; success: boolean; error?: string };

export type LifecycleEvent = (AgentEvent | LifecycleHookData) & {
  sessionId: string;
  cwd: string;
};

export interface LifecycleDecision {
  blocked: boolean;
  reason?: string;
  additionalContext?: string;
}

export type LifecycleHandler = (
  event: LifecycleEvent,
) => void | LifecycleDecision | Promise<void> | Promise<LifecycleDecision | undefined>;

/** Process-wide fan-out, ordered independently for each session. */
export class LifecycleSource {
  private readonly handlers = new Set<LifecycleHandler>();
  private readonly pending = new Map<string, Promise<unknown>>();

  subscribe(handler: LifecycleHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  dispatch(event: LifecycleEvent): Promise<LifecycleDecision> {
    const handlers = [...this.handlers];
    const previous = this.pending.get(event.sessionId) ?? Promise.resolve();
    const dispatched = previous.then(async () => {
      let result: LifecycleDecision = { blocked: false };
      for (const handler of handlers) {
        const decision = await handler(event);
        if (decision?.blocked && !result.blocked) result = decision;
      }
      return result;
    });
    // A failed observer must not poison later dispatches for this session.
    const settled = dispatched.then(
      () => {},
      () => {},
    );
    this.pending.set(event.sessionId, settled);
    void settled.then(() => {
      if (this.pending.get(event.sessionId) === settled) this.pending.delete(event.sessionId);
    });
    return dispatched;
  }

  async drain(sessionId: string): Promise<void> {
    await this.pending.get(sessionId);
  }
}

export const lifecycleSource = new LifecycleSource();
