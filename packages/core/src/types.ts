import type { ModelMessage } from 'ai';
import type { CallId, SessionId } from './ids';

export type SandboxMode = 'off' | 'bind' | 'overlay' | 'ephemeral';

export type ExecutionTarget = 'sandbox' | 'host';

export interface ModelConfig {
  providerId: string;
  modelId: string;
  maxSteps: number;
  maxTokens?: number;
  temperature?: number;
}

export interface ToolCallRecord {
  callId: CallId;
  name: string;
  args: unknown;
  target: ExecutionTarget;
  result?: unknown;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface UsageStep {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  stepCount: number;
  lastStep?: UsageStep;
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    stepCount: 0,
  };
}

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_permission'
  | 'error';

export interface Session {
  id: SessionId;
  parentId: SessionId | null;
  children: SessionId[];
  cwd: string;
  createdAt: number;
  messages: ModelMessage[];
  toolCalls: ToolCallRecord[];
  status: SessionStatus;
  model: ModelConfig;
  sandboxMode: SandboxMode;
  usage: Usage;
  /**
   * Currently active mode name. Defaults to `"build"` for new sessions and
   * for sessions persisted before the modes feature landed.
   */
  mode: string;
  /**
   * Sticky model override the user explicitly requested via `-m` at launch or
   * `/model <ref>` mid-session. Persists across mode switches; `null` means no
   * override is active.
   */
  userModelOverride: string | null;
}

/** Default mode for new sessions. Mirrored in `@chimera/modes`. */
export const DEFAULT_SESSION_MODE = 'build';

export type RememberScope =
  | { scope: 'session' }
  | { scope: 'project'; pattern: string; patternKind: 'exact' | 'glob' };
