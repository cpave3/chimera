import type { ModelMessage } from 'ai';
import type { CommandPolicyAnalysis } from './command-policy';
import type { CallId, SessionId } from './ids';
import type { PermissionRequest } from './interfaces';
import type { ExecutionTarget, TaskItem, ToolCallRecord, Usage } from './types';

/**
 * Per-tool human-readable display payload, computed by a tool's
 * `formatScrollback` hook and emitted alongside `tool_call_start` and
 * `tool_call_result` so the TUI (or any client) can render a concise summary
 * instead of the raw JSON args.
 */
export type ToolDisplay = {
  summary: string;
  label?: string;
  detail?: string;
};

/**
 * Why a run ended. `output_limit`: the model's answer was cut off by its
 * output limit and still was after the agent asked it to continue.
 */
export type RunFinishedReason =
  | 'stop'
  | 'max_steps'
  | 'error'
  | 'interrupted'
  | 'timeout'
  | 'waiting_for_input'
  | 'output_limit';

export type AgentEvent =
  | { type: 'session_started'; sessionId: SessionId }
  | { type: 'user_message'; content: string; imageCount?: number }
  | { type: 'assistant_text_delta'; id?: string; delta: string }
  | { type: 'assistant_text_done'; id?: string; text: string }
  /** Streaming delta for model reasoning content (o1, DeepSeek-R1, etc.). */
  | { type: 'reasoning_text_delta'; id?: string; delta: string }
  /** Finalized reasoning content for a reasoning turn. */
  | { type: 'reasoning_text_done'; id?: string; text: string }
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
      policyAnalysis?: CommandPolicyAnalysis;
      mcp?: PermissionRequest['mcp'];
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
      type: 'mode_changed';
      from: string;
      to: string;
      reason: 'user' | 'startup' | 'command' | 'subagent-inherit' | 'resume';
      effectiveModel: string;
      effectiveModelChanged: boolean;
    }
  | {
      type: 'model_changed';
      from: string;
      to: string;
    }
  | { type: 'model_settings_changed'; settingsState: import('./model-settings').ModelSettingsState }
  /**
   * A turn carrying images was routed to the configured vision model because
   * the active model is not vision-capable. Run-scoped: `vision_route_ended`
   * fires before the same run's `run_finished`.
   */
  | {
      type: 'vision_route_started';
      from: string;
      to: string;
      trigger: 'user_images' | 'tool_image';
    }
  | { type: 'vision_route_ended'; restored: string }
  /**
   * Images appeared mid-run but no usable vision fallback is configured;
   * the run continues on the current model with images substituted by text
   * placeholders.
   */
  | { type: 'vision_route_unavailable'; reason: string }
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
      /**
       * True for a child the model started with `background: true`: the tool
       * call that started it returns at once, and the child's events go on
       * after that call's result.
       */
      background?: boolean;
    }
  | { type: 'subagent_event'; subagentId: string; event: AgentEvent }
  | {
      type: 'subagent_finished';
      subagentId: string;
      parentCallId: CallId;
      result: string;
      reason: string;
    }
  | {
      type: 'background_process_exited';
      shellId: string;
      command: string;
      status: 'exited' | 'killed';
      exitCode: number | null;
    }
  | { type: 'task_list_updated'; tasks: TaskItem[] }
  | {
      type: 'user_input_required';
      request: string;
      kind?: 'information' | 'action';
    }
  | { type: 'step_finished'; stepNumber: number; finishReason: string }
  /**
   * The model's answer was cut off by its output limit and the agent asked
   * it to continue. `attempt` counts from 1.
   */
  | { type: 'output_continued'; attempt: number; maxAttempts: number }
  /**
   * The active model stayed unavailable after every retry; the rest of this
   * run uses the configured fallback model. The session model is unchanged.
   */
  | { type: 'model_fallback'; from: string; to: string; error: string }
  /**
   * A model step failed with a temporary provider error and will be sent
   * again after `delayMs`. `attempt` counts from 1.
   */
  | {
      type: 'provider_retry';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: string;
    }
  | {
      type: 'usage_updated';
      usage: Usage;
      contextWindow: number;
      usedContextTokens: number;
      unknownWindow: boolean;
    }
  | {
      type: 'run_finished';
      reason: RunFinishedReason;
      error?: string;
    }
  | {
      type: 'compaction_started';
      /** `overflow`: the provider rejected the prompt for its length. */
      reason: 'threshold' | 'manual' | 'overflow';
    }
  | {
      type: 'compaction_finished';
      summary: string;
      tokensBefore: number;
      tokensAfter: number;
      messagesReplaced: number;
      strategy?: string;
      prunedCount?: number;
      prunedTokensSaved?: number;
    }
  | {
      type: 'compaction_failed';
      error: string;
    }
  | {
      type: 'forked_from';
      parentId: SessionId;
      parentEventCount: number;
      purpose?: string;
    };

export type AgentEventEnvelope = AgentEvent & {
  eventId: string;
  sessionId: SessionId;
  ts: number;
};

/**
 * On-disk representation of events written to `events.jsonl`. The persisted
 * `step_finished` line carries a snapshot of the cumulative `messages`,
 * `toolCalls`, and `usage` at step boundary so that resume can rehydrate
 * conversation state without replaying the full event log.
 *
 * Only event types in this union are persisted; transient events such as
 * `assistant_text_delta`, `tool_call_start`, etc. are filtered out.
 */
export type PersistedEvent =
  | {
      type: 'step_finished';
      stepNumber: number;
      finishReason: string;
      messages: ModelMessage[];
      toolCalls: ToolCallRecord[];
      usage: Usage;
    }
  | {
      type: 'permission_resolved';
      requestId: string;
      decision: 'allow' | 'deny';
      remembered: boolean;
    }
  | {
      type: 'run_finished';
      reason: RunFinishedReason;
      error?: string;
    }
  | {
      type: 'forked_from';
      parentId: SessionId;
      parentEventCount: number;
      purpose?: string;
    }
  | {
      type: 'message_appended';
      messages: ModelMessage[];
      toolCalls: ToolCallRecord[];
      usage: Usage;
    };
