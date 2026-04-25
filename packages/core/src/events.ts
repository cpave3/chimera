import type { CallId, SessionId } from './ids';
import type { ExecutionTarget, Usage } from './types';

/**
 * Per-tool human-readable display payload, computed by a tool's
 * `formatScrollback` hook and emitted alongside `tool_call_start` and
 * `tool_call_result` so the TUI (or any client) can render a concise summary
 * instead of the raw JSON args.
 */
export type ToolDisplay = {
  summary: string;
  detail?: string;
};

export type AgentEvent =
  | { type: 'session_started'; sessionId: SessionId }
  | { type: 'user_message'; content: string }
  | { type: 'assistant_text_delta'; delta: string }
  | { type: 'assistant_text_done'; text: string }
  | {
      type: 'tool_call_start';
      callId: CallId;
      name: string;
      args: unknown;
      target: ExecutionTarget;
      display?: ToolDisplay;
    }
  | {
      type: 'tool_call_result';
      callId: CallId;
      result: unknown;
      durationMs: number;
      display?: ToolDisplay;
    }
  | { type: 'tool_call_error'; callId: CallId; error: string }
  | {
      type: 'permission_request';
      requestId: string;
      tool: string;
      target: 'host';
      command: string;
      reason?: string;
    }
  | {
      type: 'permission_resolved';
      requestId: string;
      decision: 'allow' | 'deny';
      remembered: boolean;
    }
  | { type: 'permission_timeout'; requestId: string }
  | {
      type: 'skill_activated';
      skillName: string;
      source: 'project' | 'user' | 'claude-compat';
    }
  | { type: 'command_invoked'; commandName: string; expandedPrompt: string }
  | {
      type: 'subagent_spawned';
      subagentId: string;
      parentCallId: CallId;
      /**
       * The child's session id. Named `childSessionId` (rather than `sessionId`)
       * to avoid collision with the envelope's `sessionId` field, which is
       * unconditionally set to the *parent's* session id by `EventBus.publish`.
       */
      childSessionId: SessionId;
      url: string;
      purpose: string;
    }
  | { type: 'subagent_event'; subagentId: string; event: AgentEvent }
  | {
      type: 'subagent_finished';
      subagentId: string;
      parentCallId: CallId;
      result: string;
      reason: string;
    }
  | { type: 'step_finished'; stepNumber: number; finishReason: string }
  | {
      type: 'usage_updated';
      usage: Usage;
      contextWindow: number;
      usedContextTokens: number;
    }
  | {
      type: 'run_finished';
      reason: 'stop' | 'max_steps' | 'error' | 'interrupted';
      error?: string;
    };

export type AgentEventEnvelope = AgentEvent & {
  eventId: string;
  sessionId: SessionId;
  ts: number;
};
