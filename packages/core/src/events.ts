import type { CallId, SessionId } from './ids';
import type { ExecutionTarget } from './types';

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
    }
  | {
      type: 'tool_call_result';
      callId: CallId;
      result: unknown;
      durationMs: number;
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
      sessionId: SessionId;
      url: string;
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
      type: 'run_finished';
      reason: 'stop' | 'max_steps' | 'error' | 'interrupted';
      error?: string;
    };

export type AgentEventEnvelope = AgentEvent & {
  eventId: string;
  sessionId: SessionId;
  ts: number;
};
