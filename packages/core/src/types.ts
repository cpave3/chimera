import type { ModelMessage } from 'ai';
import type { AgentEvent } from './events';
import type { CallId, SessionId } from './ids';

export type SandboxMode = 'off' | 'bind' | 'overlay' | 'ephemeral';

export type ExecutionTarget = 'sandbox' | 'host';

export interface ModelConfig {
  providerId: string;
  modelId: string;
  maxSteps: number;
  /**
   * Per-step output cap forwarded to the AI SDK's `maxOutputTokens`. When
   * unset, no cap is sent and the provider applies its server-side default —
   * which for some endpoints (e.g. synthetic.new) is 2048 tokens, low enough
   * to truncate long syntheses mid-output. Configure via `models[ref]` in
   * `~/.chimera/config.json`.
   */
  maxOutputTokens?: number;
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

export interface FileOps {
  reads: Set<string>;
  writes: Set<string>;
}

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
  /**
   * File-operation tracking (reads, writes), updated by tool completion and
   * persisted as sorted arrays in session metadata.
   */
  fileOps: FileOps;
}

/** Default mode for new sessions. Mirrored in `@chimera/modes`. */
export const DEFAULT_SESSION_MODE = 'build';

export interface CompactionConfig {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  model?: string;
}

/**
 * Minimal interface for the compactor injected by the factory.
 * The concrete implementation lives in `@chimera/compaction`.
 */
export interface CompactorApi {
  maybeCompact(session: Session): Promise<boolean>;
  compact(
    session: Session,
    reason: 'threshold' | 'manual',
  ): Promise<{ summary: string; tokensBefore: number; tokensAfter: number; messagesReplaced: number }>;
  /**
   * Rebind the event emitter so the agent can pipe compaction events into the
   * current run queue.  Implementations (e.g. `Compactor`) should accept an
   * optional emit callback and replace whatever was wired at construction time.
   */
  setEmit?(
    emit: (event: AgentEvent) => void | Promise<void>,
  ): void;
}

export type RememberScope =
  | { scope: 'session' }
  | { scope: 'project'; pattern: string; patternKind: 'exact' | 'glob' };
