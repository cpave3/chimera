import type { ModelMessage } from 'ai';
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
  /**
   * True when the model accepts image content parts. Config-declared
   * (`models[ref].vision` in `~/.chimera/config.json`); absent means the
   * model is treated as text-only and image turns route to the configured
   * `defaultVisionModel`.
   */
  vision?: boolean;
  /**
   * Optional compatibility mode for the tool surface exposed to this model.
   * Undefined means Chimera's native tool names and argument schemas.
   */
  toolCallShape?: 'chimera' | 'codex';
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

export type TaskItemStatus = 'pending' | 'in_progress' | 'completed';

/** One entry in the model-maintained task list (task_list tool). */
export interface TaskItem {
  content: string;
  status: TaskItemStatus;
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
  /**
   * Additional absolute paths (outside cwd) the agent is allowed to read via
   * tool calls. Persisted in session metadata so resuming/forking retains them.
   */
  additionalReadPaths: string[];
  /**
   * Additional absolute paths (outside cwd) the agent is allowed to write via
   * tool calls. Persisted in session metadata so resuming/forking retains them.
   */
  additionalWritePaths: string[];
  /**
   * Model-maintained task list (task_list tool). Persisted in session
   * metadata so it survives resume and context compaction.
   */
  tasks: TaskItem[];
}

/** Default mode for new sessions. Mirrored in `@chimera/modes`. */
export const DEFAULT_SESSION_MODE = 'build';

export interface CompactionConfig {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  model?: string;
  /**
   * Compact when the projected prompt crosses this percentage of the
   * context window (effective trigger = min(window * pct, window - reserve)).
   * Default 85.
   */
  thresholdPercent?: number;
}

/**
 * Minimal interface for the compactor injected by the factory.
 * The concrete implementation lives in `@chimera/compaction`.
 */
export interface CompactionOutcome {
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  messagesReplaced: number;
  /** Which tiers ran: 'prune' | 'prune+summarize' | 'summarize'. */
  strategy?: string;
  prunedCount?: number;
  prunedTokensSaved?: number;
}

export interface CompactorApi {
  maybeCompact(session: Session): Promise<{ ran: false } | ({ ran: true } & CompactionOutcome)>;
  compact(session: Session, reason: 'threshold' | 'manual'): Promise<CompactionOutcome>;
}

export type RememberScope =
  | { scope: 'session' }
  | { scope: 'project'; pattern: string; patternKind: 'exact' | 'glob' };
